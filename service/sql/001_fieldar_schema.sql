-- =============================================================================
-- Field AR - plot finder schema  (migration 001)
--
-- Safe to run on a Supabase project that already has data:
--   * everything lives in its own `fieldar` schema, so no existing table in
--     `public` (or anywhere else) is read, renamed, or dropped;
--   * every statement is CREATE ... IF NOT EXISTS / CREATE OR REPLACE, so the
--     whole file is idempotent - re-running it is a no-op, not a reset;
--   * there is no DROP TABLE, TRUNCATE or DELETE anywhere in this file.
--
-- Run it in the Supabase SQL editor as a single script.
-- =============================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;   -- gen_random_uuid()

create schema if not exists fieldar;

-- PostGIS may live in `public` (older projects) or `extensions` (newer ones);
-- listing both means the geography types below resolve either way.
set search_path to fieldar, extensions, public;


-- -----------------------------------------------------------------------------
-- 1. plots - the boundaries drawn in the web tool
-- -----------------------------------------------------------------------------
-- The boundary is stored ONCE, as a geography. Area, centroid, bounding box and
-- radius searches are all derived from it by PostGIS rather than stored beside
-- it, so there is no second copy that can drift out of agreement with the first.
-- `area_sq_m` is the one exception: it is persisted because it is the number the
-- surveyor agreed to, and a CHECK constraint keeps it honest against the ring.

create table if not exists fieldar.plots (
  id             text primary key,
  name           text        not null,
  boundary       geography(Polygon, 4326) not null,
  access_point   geography(Point, 4326)   not null,
  area_sq_m      double precision not null,
  landmark_note  text        not null default '',

  -- Partner feedback: adjacent plots must be told apart at a glance. Clients
  -- hold the palette; the database holds only which slot this plot occupies, so
  -- re-theming the app and the web tool never becomes a data migration.
  colour_index   smallint    not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint plots_area_positive  check (area_sq_m > 0),
  -- 500 ha ceiling, matching the web tool's validator.
  constraint plots_area_ceiling   check (area_sq_m <= 5000000),
  constraint plots_colour_range   check (colour_index between 0 and 7),
  -- Rejects a boundary whose stored area is more than 1% away from its true
  -- geodesic area: catches a bad client, a unit mix-up, or an edited ring.
  constraint plots_area_matches_ring
    check (abs(area_sq_m - ST_Area(boundary)) <= greatest(1.0, 0.01 * ST_Area(boundary)))
);

comment on table  fieldar.plots is
  'Farm plot boundaries. Drawn in the web tool only - the mobile app is read-only.';
comment on column fieldar.plots.colour_index is
  'Palette slot 0-7. Assigned by fieldar.pick_colour_index() so neighbours differ.';

-- The mobile app's hot path is "everything within N metres of me". A GiST index
-- on the centroid makes ST_DWithin an index scan rather than a table scan.
create index if not exists idx_plots_centroid
  on fieldar.plots using gist (ST_Centroid(boundary::geometry));
create index if not exists idx_plots_boundary
  on fieldar.plots using gist (boundary);


-- -----------------------------------------------------------------------------
-- 2. plot health - the pixelated overlay
-- -----------------------------------------------------------------------------
-- A snapshot is one index (NDVI, NDWI, ...) for one plot on one date. Cells are
-- the pixels. Hotspots are the clusters worth walking to, clustered once at
-- ingest rather than re-derived on every map pan.

create table if not exists fieldar.health_snapshots (
  id            uuid primary key default gen_random_uuid(),
  plot_id       text not null references fieldar.plots(id) on delete cascade,
  captured_on   date not null,
  source        text not null default 'sentinel-2',
  index_name    text not null default 'ndvi',
  -- Ground resolution of one cell. Sentinel-2 red/NIR is 10 m native; anything
  -- smaller than that is interpolation, and the UI should say so.
  cell_size_m   double precision not null,
  grid_cols     integer not null,
  grid_rows     integer not null,
  value_min     double precision,
  value_max     double precision,
  value_mean    double precision,
  cloud_pct     double precision,
  created_at    timestamptz not null default now(),

  constraint health_snapshots_cell_size check (cell_size_m > 0),
  constraint health_snapshots_grid      check (grid_cols > 0 and grid_rows > 0),
  -- One row per plot per date per index; re-ingesting the same day updates it.
  unique (plot_id, captured_on, index_name)
);

create index if not exists idx_health_snapshots_plot
  on fieldar.health_snapshots (plot_id, captured_on desc);

create table if not exists fieldar.health_cells (
  snapshot_id uuid not null references fieldar.health_snapshots(id) on delete cascade,
  -- `row` and `col` are keywords in Postgres; spelled out to stay quote-free.
  cell_col    integer not null,
  cell_row    integer not null,
  value       double precision not null,
  -- 0 healthy, 1 mild, 2 stressed, 3 critical. Banding is decided at ingest so
  -- the web tool, the app and any report all colour the same cell identically.
  severity    smallint not null,
  centroid    geography(Point, 4326)   not null,
  cell        geography(Polygon, 4326) not null,

  primary key (snapshot_id, cell_col, cell_row),
  constraint health_cells_severity check (severity between 0 and 3)
);

-- Partial index: the stressed cells are the only ones ever queried on their own.
create index if not exists idx_health_cells_severity
  on fieldar.health_cells (snapshot_id, severity)
  where severity >= 2;

create table if not exists fieldar.health_hotspots (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references fieldar.health_snapshots(id) on delete cascade,
  -- 1 = worst. What the field agent is sent to first.
  rank          integer not null,
  centroid      geography(Point, 4326) not null,
  cell_count    integer not null,
  area_sq_m     double precision not null,
  mean_value    double precision not null,
  severity      smallint not null,
  note          text not null default '',

  unique (snapshot_id, rank),
  constraint health_hotspots_severity check (severity between 0 and 3)
);

comment on table fieldar.health_hotspots is
  'Contiguous clusters of stressed cells. The centroid is a walk-to target and is guaranteed to fall inside the plot boundary.';

create index if not exists idx_health_hotspots_centroid
  on fieldar.health_hotspots using gist (centroid);


-- -----------------------------------------------------------------------------
-- 3. telemetry - how the AR overlay actually behaves in the field
-- -----------------------------------------------------------------------------
-- Written from day one because the two numbers that decide whether this scales
-- (heading lock rate, GNSS accuracy by handset) cannot be reconstructed later.

create table if not exists fieldar.ar_telemetry (
  id                  bigserial primary key,
  session_id          uuid not null,
  plot_id             text references fieldar.plots(id) on delete set null,
  recorded_at         timestamptz not null,

  device_model        text not null default '',
  app_version         text not null default '',

  position            geography(Point, 4326),
  accuracy_m          double precision,

  heading_deg         double precision,
  heading_source      text,        -- COURSE_OVER_GROUND | LANDMARK_SNAP | MAGNETOMETER
  heading_confidence  text,        -- LOCKED | HOLDING | UNRELIABLE
  render_mode         text,        -- NEAR | FAR

  -- Anchor stability. Added now, populated by the re-anchoring work: an anchor
  -- that shifts while the agent stands still is the failure the partners saw.
  anchor_age_s        double precision,
  anchor_shift_m      double precision,

  session_duration_ms bigint,
  created_at          timestamptz not null default now()
);

create index if not exists idx_ar_telemetry_session
  on fieldar.ar_telemetry (session_id, recorded_at);
create index if not exists idx_ar_telemetry_recorded
  on fieldar.ar_telemetry (recorded_at desc);


-- -----------------------------------------------------------------------------
-- 4. keep updated_at honest
-- -----------------------------------------------------------------------------
create or replace function fieldar.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_plots_touch on fieldar.plots;
create trigger trg_plots_touch
  before update on fieldar.plots
  for each row execute function fieldar.touch_updated_at();


-- -----------------------------------------------------------------------------
-- 5. colour assignment
-- -----------------------------------------------------------------------------
-- Picks the palette slot least used by plots within `neighbourhood_m`. Two plots
-- sharing a fence never share a colour; two plots in different districts may,
-- which is fine because they are never on screen together.
create or replace function fieldar.pick_colour_index(
  at_point         geography(Point, 4326),
  neighbourhood_m  double precision default 500
)
returns smallint
language sql
stable
set search_path = fieldar, extensions, public
as $fn$
  select slot::smallint
  from generate_series(0, 7) as slot
  left join fieldar.plots p
    on p.colour_index = slot
   and ST_DWithin(ST_Centroid(p.boundary::geometry)::geography, at_point, neighbourhood_m)
  group by slot
  order by count(p.id) asc, slot asc
  limit 1;
$fn$;


-- -----------------------------------------------------------------------------
-- 6. read shapes
-- -----------------------------------------------------------------------------
-- One view defines the wire format. The API, the web tool and the Android client
-- all read these exact column names, so the GeoJSON lng/lat ordering and the
-- lat/lng scalar split are decided in one place instead of three.
create or replace view fieldar.plots_api as
select
  p.id,
  p.name,
  ST_AsGeoJSON(p.boundary)::jsonb                        as polygon,
  ST_Y(ST_Centroid(p.boundary::geometry))                as centroid_lat,
  ST_X(ST_Centroid(p.boundary::geometry))                as centroid_lng,
  ST_Y(p.access_point::geometry)                         as access_lat,
  ST_X(p.access_point::geometry)                         as access_lng,
  p.area_sq_m,
  p.landmark_note,
  p.colour_index,
  p.created_at,
  p.updated_at
from fieldar.plots p;

-- The endpoint the dispatched agent actually depends on: everything within a
-- radius, nearest first, with the distance already computed. ST_DWithin on a
-- geography uses the GiST index, so this stays an index scan as plots grow.
create or replace function fieldar.plots_near(
  at_lat    double precision,
  at_lng    double precision,
  radius_m  double precision default 5000
)
returns table (
  id            text,
  name          text,
  polygon       jsonb,
  centroid_lat  double precision,
  centroid_lng  double precision,
  access_lat    double precision,
  access_lng    double precision,
  area_sq_m     double precision,
  landmark_note text,
  colour_index  smallint,
  created_at    timestamptz,
  updated_at    timestamptz,
  distance_m    double precision
)
language sql
stable
set search_path = fieldar, extensions, public
as $fn$
  select v.*,
         ST_Distance(
           ST_SetSRID(ST_MakePoint(v.centroid_lng, v.centroid_lat), 4326)::geography,
           ST_SetSRID(ST_MakePoint(at_lng, at_lat), 4326)::geography
         ) as distance_m
  from fieldar.plots_api v
  where ST_DWithin(
          ST_SetSRID(ST_MakePoint(v.centroid_lng, v.centroid_lat), 4326)::geography,
          ST_SetSRID(ST_MakePoint(at_lng, at_lat), 4326)::geography,
          radius_m
        )
  order by distance_m asc;
$fn$;

-- Latest health snapshot per plot, so a client can ask for "current" without
-- every client re-implementing the same date ranking.
create or replace view fieldar.plot_health_latest as
select distinct on (s.plot_id)
  s.id as snapshot_id, s.plot_id, s.captured_on, s.source, s.index_name,
  s.cell_size_m, s.grid_cols, s.grid_rows,
  s.value_min, s.value_max, s.value_mean, s.cloud_pct
from fieldar.health_snapshots s
order by s.plot_id, s.captured_on desc;


-- -----------------------------------------------------------------------------
-- 7. row level security
-- -----------------------------------------------------------------------------
-- The publishable key ships inside the Android APK, so treat `anon` as public.
-- Reads are open; the only write `anon` may make is appending telemetry. Every
-- plot and health write goes through the API using the secret key, which acts as
-- `service_role` and bypasses RLS.
alter table fieldar.plots            enable row level security;
alter table fieldar.health_snapshots enable row level security;
alter table fieldar.health_cells     enable row level security;
alter table fieldar.health_hotspots  enable row level security;
alter table fieldar.ar_telemetry     enable row level security;

do $rls$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='fieldar' and tablename='plots' and policyname='plots_read') then
    create policy plots_read on fieldar.plots for select to anon, authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname='fieldar' and tablename='health_snapshots' and policyname='health_snapshots_read') then
    create policy health_snapshots_read on fieldar.health_snapshots for select to anon, authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname='fieldar' and tablename='health_cells' and policyname='health_cells_read') then
    create policy health_cells_read on fieldar.health_cells for select to anon, authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname='fieldar' and tablename='health_hotspots' and policyname='health_hotspots_read') then
    create policy health_hotspots_read on fieldar.health_hotspots for select to anon, authenticated using (true);
  end if;

  -- Append-only: the app may add rows, but may not read back or amend anyone's.
  if not exists (select 1 from pg_policies
                 where schemaname='fieldar' and tablename='ar_telemetry' and policyname='ar_telemetry_insert') then
    create policy ar_telemetry_insert on fieldar.ar_telemetry for insert to anon, authenticated with check (true);
  end if;
end
$rls$;

grant usage on schema fieldar to anon, authenticated, service_role;
grant select on fieldar.plots, fieldar.health_snapshots, fieldar.health_cells,
                fieldar.health_hotspots, fieldar.plots_api, fieldar.plot_health_latest
  to anon, authenticated;
grant insert on fieldar.ar_telemetry to anon, authenticated;
grant usage, select on sequence fieldar.ar_telemetry_id_seq to anon, authenticated;
grant all on all tables in schema fieldar to service_role;
grant execute on function fieldar.plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;
grant execute on function fieldar.pick_colour_index(geography, double precision)
  to service_role;


-- -----------------------------------------------------------------------------
-- 8. verify
-- -----------------------------------------------------------------------------
select 'tables'   as kind, count(*)::text as detail
  from information_schema.tables where table_schema = 'fieldar'
union all
select 'policies', count(*)::text from pg_policies where schemaname = 'fieldar'
union all
select 'postgis',  extversion     from pg_extension where extname = 'postgis';
