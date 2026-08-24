# Plot Visualizer

Draw farm plot boundaries on satellite imagery, grade plot health, and serve both
to the companion Android AR app that finds those boundaries in the field.

This repository is the web half. Boundaries are created **here and only here** —
the mobile app is a reader.

```
shared/   @plot/shared  types, geodesic geometry, validation, palette, health grid
api/      @plot/api     Express + the storage drivers
web/      @plot/web     React + MapLibre draw tool
server/                 Vercel serverless entry (wraps the same Express app)
```

---

## Run it locally

```bash
npm install
npm run seed        # 6 adjacent plots near Bellur, Karnataka
npm run dev:api     # :4000 — prints the LAN address a phone should use
npm run dev:web     # :5173
```

`npm run seed` and the API both write to a local SQLite file unless Supabase is
configured. `GET /api/health` always names the driver in use.

---

## Deploy

### 1. Database

Run these against your Supabase project, in order, in the SQL editor:

| File | What it does |
|------|--------------|
| `api/sql/001_fieldar_schema.sql` | Tables, indexes, RLS, and the `?near=` function, all inside a `fieldar` schema |
| `api/sql/002_api_surface.sql` | The `public.fieldar_*` wrappers PostgREST actually serves |

Both are idempotent and additive. Neither contains a `DROP TABLE`, `TRUNCATE`,
or `DELETE`, so running them on a project that already has tables is safe.

`002` exists because PostgREST only serves schemas listed under *Exposed
schemas*, which defaults to `public`. Publishing thin wrappers there means the
deployment does not depend on anyone remembering a dashboard setting — a step
that fails silently, as a 404 on every request.

### 2. Vercel

Import this repository and set two environment variables:

```
SUPABASE_URL         https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY  the secret / service_role key
```

`vercel.json` handles the rest: `web/dist` is served statically, `/api/*` is
rewritten to `server/index.ts`, and everything else falls through to
`index.html` for client-side routing.

**The secret key is server-side only.** It bypasses every row-level security
policy. It must never appear in the browser bundle or in the Android app, both
of which use the publishable key and are confined by RLS to reading plots and
appending telemetry.

### 3. Seed the deployed database

```bash
SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run seed
```

---

## Why two storage drivers

`api/src/store/` holds a `PlotStore` interface with two implementations:

- **sqlite** — local development and the test suite. No network, no credentials,
  and `:memory:` gives every test run a clean database.
- **supabase** — anything deployed. Vercel functions have an ephemeral
  filesystem, so a file-backed database there loses every plot when the instance
  is recycled.

What is *not* duplicated is validation. Both drivers receive a `NormalizedPlot`
that has already been through `validatePlotInput()` in `@plot/shared`, so the
recomputed area, the centroid, and every rejection rule are decided in one place
regardless of where the row ends up. The Postgres schema then enforces the same
rules a second time as CHECK constraints, because a constraint protects every
path into the table and an application validator only protects one.

The SQLite driver is loaded by dynamic import. `better-sqlite3` is a native
addon; a statically imported one would be bundled into the serverless function
and loaded on every cold start despite never being used.

---

## Plot health

The `Plot health` toggle grades the selected plot into a 10 m NDVI grid and ranks
the contiguous stressed patches, each with a coordinate that is guaranteed to
fall inside the boundary — the field agent reads it off the screen, or clicks to
copy it, and walks there.

**The index values are synthetic.** `syntheticNdviSampler` is deterministic
noise shaped to look like a real stress pattern, not remote sensing. Every API
response carries `synthetic: true` and the UI shows an amber warning, because a
fabricated NDVI presented as a measured one is a wrong agronomic recommendation.
Wiring real Sentinel-2 means replacing one function — everything downstream takes
an `IndexSampler` and knows nothing about where the numbers came from.

---

## Tests

```bash
npm run typecheck   # shared, api, web
npm run test:api    # 16 end-to-end tests against the real Express app
npm run build
```

The API tests run the real app over HTTP against an in-memory SQLite database,
so they exercise the same validation, routing and `?near=` arithmetic that
ships.
