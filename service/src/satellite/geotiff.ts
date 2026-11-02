import zlib from 'node:zlib';

/**
 * Reads a window of pixels from a Cloud-Optimised GeoTIFF over HTTP.
 *
 * A Sentinel-2 band is a 110 km square; a plot is a few dozen metres. A COG is
 * laid out so a reader can fetch its header, then only the tiles that cover
 * the area of interest, with HTTP range requests - a megabyte or two instead of
 * a hundred. This implements exactly the part of TIFF that needs: the header
 * and first IFD (classic or BigTIFF, either byte order), tiled layout, Deflate
 * or LZW compression (and Zstandard where the runtime has it), the horizontal
 * predictor, 8- and 16-bit integer samples, and the GeoTIFF tie point and
 * pixel size that place a pixel on the ground. No dependency: the service is
 * deployed with its lockfile, and this is all it needs from a TIFF library.
 */

/** Fetches bytes [start, endInclusive] of [url]. Injectable for tests. */
export type RangeFetcher = (url: string, start: number, endInclusive: number) => Promise<Uint8Array>;

export const httpRange: RangeFetcher = async (url, start, endInclusive) => {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} reading ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file with a 200.
  return res.status === 200 ? bytes.subarray(start, endInclusive + 1) : bytes;
};

/** Bytes fetched up front: enough for the header and tile index of a COG. */
const HEADER_BYTES = 65536;

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  gdalNoData: 42113,
} as const;

/** Bytes per value of each TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };

/** A window of pixels: row-major, NaN where there is no data. */
export interface PixelWindow {
  col0: number;
  row0: number;
  width: number;
  height: number;
  data: Float32Array;
}

export class Cog {
  private constructor(
    readonly url: string,
    private readonly fetcher: RangeFetcher,
    readonly width: number,
    readonly height: number,
    private readonly tileWidth: number,
    private readonly tileHeight: number,
    private readonly bitsPerSample: number,
    private readonly signed: boolean,
    private readonly compression: number,
    private readonly predictor: number,
    private readonly littleEndian: boolean,
    private readonly tileOffsets: number[],
    private readonly tileByteCounts: number[],
    /** Map coordinates of the image's top-left corner, and one pixel's size. */
    readonly originX: number,
    readonly originY: number,
    readonly pixelSizeX: number,
    readonly pixelSizeY: number,
    private readonly noData: number | null,
  ) {}

  static async open(url: string, fetcher: RangeFetcher = httpRange): Promise<Cog> {
    let head = await fetcher(url, 0, HEADER_BYTES - 1);
    const bytesAt = async (offset: number, length: number): Promise<Uint8Array> => {
      if (offset + length <= head.length) return head.subarray(offset, offset + length);
      return fetcher(url, offset, offset + length - 1);
    };

    const order = String.fromCharCode(head[0]!, head[1]!);
    if (order !== 'II' && order !== 'MM') throw new Error('not a TIFF');
    const le = order === 'II';
    const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const magic = view(head).getUint16(2, le);
    const big = magic === 43;
    if (magic !== 42 && !big) throw new Error(`not a TIFF (magic ${magic})`);
    const ifdOffset = big ? Number(view(head).getBigUint64(8, le)) : view(head).getUint32(4, le);

    if (ifdOffset + 8 > head.length) head = await fetcher(url, 0, ifdOffset + HEADER_BYTES);
    const countSize = big ? 8 : 2;
    const entrySize = big ? 20 : 12;
    const inlineSize = big ? 8 : 4;
    const entries = big ? Number(view(head).getBigUint64(ifdOffset, le)) : view(head).getUint16(ifdOffset, le);
    const ifd = await bytesAt(ifdOffset + countSize, entries * entrySize);
    const dv = view(ifd);

    const tags = new Map<number, number[] | string>();
    for (let i = 0; i < entries; i++) {
      const at = i * entrySize;
      const tag = dv.getUint16(at, le);
      const type = dv.getUint16(at + 2, le);
      const count = big ? Number(dv.getBigUint64(at + 4, le)) : dv.getUint32(at + 4, le);
      const size = TYPE_SIZE[type];
      if (!size) continue;
      const total = size * count;
      const valueAt = at + (big ? 12 : 8);
      const raw =
        total <= inlineSize
          ? ifd.subarray(valueAt, valueAt + total)
          : await bytesAt(big ? Number(dv.getBigUint64(valueAt, le)) : dv.getUint32(valueAt, le), total);
      tags.set(tag, readValues(raw, type, count, le));
    }

    const num = (tag: number, fallback?: number): number => {
      const v = tags.get(tag);
      if (Array.isArray(v) && v.length > 0) return v[0]!;
      if (fallback !== undefined) return fallback;
      throw new Error(`TIFF tag ${tag} missing`);
    };
    const list = (tag: number): number[] => {
      const v = tags.get(tag);
      if (!Array.isArray(v)) throw new Error(`TIFF tag ${tag} missing - not a tiled GeoTIFF`);
      return v;
    };

    if (num(TAG.samplesPerPixel, 1) !== 1) throw new Error('only single-band images are supported');
    const bits = num(TAG.bitsPerSample, 8);
    if (bits !== 8 && bits !== 16) throw new Error(`${bits}-bit samples are not supported`);
    const sampleFormat = num(TAG.sampleFormat, 1);
    if (sampleFormat !== 1 && sampleFormat !== 2) throw new Error(`sample format ${sampleFormat} is not supported`);

    const scale = list(TAG.modelPixelScale);
    const tie = list(TAG.modelTiepoint);
    const noDataText = tags.get(TAG.gdalNoData);
    const noData = typeof noDataText === 'string' && noDataText.trim() !== '' ? Number(noDataText) : null;

    return new Cog(
      url,
      fetcher,
      num(TAG.imageWidth),
      num(TAG.imageLength),
      num(TAG.tileWidth),
      num(TAG.tileLength),
      bits,
      sampleFormat === 2,
      num(TAG.compression, 1),
      num(TAG.predictor, 1),
      le,
      list(TAG.tileOffsets),
      list(TAG.tileByteCounts),
      tie[3]! - tie[0]! * scale[0]!,
      tie[4]! + tie[1]! * scale[1]!,
      scale[0]!,
      scale[1]!,
      Number.isFinite(noData) ? noData : null,
    );
  }

  /** Pixel column and row (fractional, pixel corners at integers) of a map coordinate. */
  pixelOf(x: number, y: number): [number, number] {
    return [(x - this.originX) / this.pixelSizeX, (this.originY - y) / this.pixelSizeY];
  }

  /** Reads columns [col0, col1) and rows [row0, row1), clamped to the image. */
  async readWindow(col0: number, row0: number, col1: number, row1: number): Promise<PixelWindow> {
    col0 = Math.max(0, Math.floor(col0));
    row0 = Math.max(0, Math.floor(row0));
    col1 = Math.min(this.width, Math.ceil(col1));
    row1 = Math.min(this.height, Math.ceil(row1));
    const width = Math.max(0, col1 - col0);
    const height = Math.max(0, row1 - row0);
    const data = new Float32Array(width * height).fill(Number.NaN);
    if (width === 0 || height === 0) return { col0, row0, width, height, data };

    const tilesAcross = Math.ceil(this.width / this.tileWidth);
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(row0 / this.tileHeight); ty * this.tileHeight < row1; ty++) {
      for (let tx = Math.floor(col0 / this.tileWidth); tx * this.tileWidth < col1; tx++) {
        jobs.push(
          this.readTile(ty * tilesAcross + tx).then((tile) => {
            if (!tile) return;
            const tileCol0 = tx * this.tileWidth;
            const tileRow0 = ty * this.tileHeight;
            for (let r = Math.max(row0, tileRow0); r < Math.min(row1, tileRow0 + this.tileHeight); r++) {
              for (let c = Math.max(col0, tileCol0); c < Math.min(col1, tileCol0 + this.tileWidth); c++) {
                const v = tile[(r - tileRow0) * this.tileWidth + (c - tileCol0)]!;
                data[(r - row0) * width + (c - col0)] = v === this.noData ? Number.NaN : v;
              }
            }
          }),
        );
      }
    }
    await Promise.all(jobs);
    return { col0, row0, width, height, data };
  }

  private async readTile(index: number): Promise<number[] | Uint16Array | Uint8Array | Int16Array | null> {
    const offset = this.tileOffsets[index];
    const count = this.tileByteCounts[index];
    if (!offset || !count) return null;
    const compressed = await this.fetcher(this.url, offset, offset + count - 1);
    const raw = decompress(compressed, this.compression);
    const samples = this.tileWidth * this.tileHeight;
    const values = toSamples(raw, samples, this.bitsPerSample, this.signed, this.littleEndian);
    if (this.predictor === 2) undoHorizontalPredictor(values, this.tileWidth, this.tileHeight, this.bitsPerSample);
    else if (this.predictor !== 1) throw new Error(`predictor ${this.predictor} is not supported`);
    return values;
  }
}

function readValues(raw: Uint8Array, type: number, count: number, le: boolean): number[] | string {
  if (type === 2) return new TextDecoder().decode(raw).replace(/\0+$/, '');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 1:
      case 7:
        out.push(dv.getUint8(i));
        break;
      case 6:
        out.push(dv.getInt8(i));
        break;
      case 3:
        out.push(dv.getUint16(i * 2, le));
        break;
      case 8:
        out.push(dv.getInt16(i * 2, le));
        break;
      case 4:
      case 13:
        out.push(dv.getUint32(i * 4, le));
        break;
      case 9:
        out.push(dv.getInt32(i * 4, le));
        break;
      case 11:
        out.push(dv.getFloat32(i * 4, le));
        break;
      case 12:
        out.push(dv.getFloat64(i * 8, le));
        break;
      case 16:
      case 18:
        out.push(Number(dv.getBigUint64(i * 8, le)));
        break;
      case 17:
        out.push(Number(dv.getBigInt64(i * 8, le)));
        break;
      case 5:
        out.push(dv.getUint32(i * 8, le) / dv.getUint32(i * 8 + 4, le));
        break;
      case 10:
        out.push(dv.getInt32(i * 8, le) / dv.getInt32(i * 8 + 4, le));
        break;
    }
  }
  return out;
}

function decompress(bytes: Uint8Array, compression: number): Uint8Array {
  switch (compression) {
    case 1:
      return bytes;
    case 8:
    case 32946:
      try {
        return zlib.inflateSync(bytes);
      } catch {
        return zlib.inflateRawSync(bytes);
      }
    case 5:
      return lzwDecode(bytes);
    case 50000: {
      const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Uint8Array }).zstdDecompressSync;
      if (!zstd) throw new Error('Zstandard-compressed TIFF needs a newer Node runtime');
      return zstd(bytes);
    }
    default:
      throw new Error(`TIFF compression ${compression} is not supported`);
  }
}

function toSamples(
  raw: Uint8Array,
  count: number,
  bits: number,
  signed: boolean,
  le: boolean,
): Uint8Array | Uint16Array | Int16Array {
  if (bits === 8) return raw.subarray(0, count);
  const out = signed ? new Int16Array(count) : new Uint16Array(count);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = Math.min(count, Math.floor(raw.byteLength / 2));
  for (let i = 0; i < n; i++) out[i] = signed ? dv.getInt16(i * 2, le) : dv.getUint16(i * 2, le);
  return out;
}

/** TIFF predictor 2: each sample was stored as the difference from the one to its left. */
export function undoHorizontalPredictor(
  values: Uint8Array | Uint16Array | Int16Array,
  width: number,
  height: number,
  bits: number,
): void {
  const mask = bits === 8 ? 0xff : 0xffff;
  for (let row = 0; row < height; row++) {
    const start = row * width;
    for (let col = 1; col < width; col++) {
      // Typed arrays wrap on assignment, which is exactly the modular sum wanted.
      values[start + col] = (values[start + col]! + values[start + col - 1]!) & mask;
    }
  }
}

/** TIFF LZW: MSB-first codes, 9 to 12 bits, with the "early change" of the code width. */
export function lzwDecode(input: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;
  const out: number[] = [];
  let table: number[][] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([], []);
  };
  reset();
  let codeWidth = 9;
  let bitPos = 0;
  let previous: number[] | null = null;
  const totalBits = input.length * 8;
  while (bitPos + codeWidth <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeWidth; i++) {
      const bit = (input[(bitPos + i) >> 3]! >> (7 - ((bitPos + i) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += codeWidth;
    if (code === EOI) break;
    if (code === CLEAR) {
      reset();
      codeWidth = 9;
      previous = null;
      continue;
    }
    let entry: number[];
    if (code < table.length && table[code]!.length > 0) entry = table[code]!;
    else if (previous) entry = [...previous, previous[0]!];
    else throw new Error('corrupt LZW data');
    for (const b of entry) out.push(b);
    if (previous) table.push([...previous, entry[0]!]);
    previous = entry;
    if (table.length + 1 >= 1 << codeWidth && codeWidth < 12) codeWidth++;
  }
  return Uint8Array.from(out);
}
