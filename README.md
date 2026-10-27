# Plot Visualizer

Draw farm plot boundaries on satellite imagery, grade crop condition - crop
greenness (NDVI), crop vigour (NDRE) and water stress (LSWI) - in 3 m cells, and
serve both to the companion Android AR app that shows every nearby plot and its
problem patches in the field.

This repository is the web half. Boundaries are created **here and only here** —
the mobile app is a reader.

```
shared/         @plot/shared  types, geodesic geometry, validation, palette, health grid
service/        @plot/api     Express + the storage drivers
web/            @plot/web     React + MapLibre draw tool
api/[...path].ts              Vercel Function; wraps the same Express app
```

---

## Run it locally

```bash
npm install
npm run seed        # 6 adjacent ~0.17 ha plots near Bellur, Karnataka
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
| `service/sql/001_fieldar_schema.sql` | Tables, indexes, RLS, and the `?near=` function, all inside a `fieldar` schema |
| `service/sql/002_api_surface.sql` | The `public.fieldar_*` wrappers PostgREST actually serves |
| `service/sql/003_updated_flow.sql` | **Wipes every plot**, removes the access point, narrows zones to three |

001 and 002 are idempotent and additive. **003 is destructive on purpose**: the
updated flow starts from a clean slate, so it deletes all plots (and their stored
health) before dropping the `access_point` column. Run it once, in one go - it is
a single transaction.

`002` exists because PostgREST only serves schemas listed under *Exposed
schemas*, which defaults to `public`. Publishing thin wrappers there means the
deployment does not depend on anyone remembering a dashboard setting — a step
that fails silently, as a 404 on every request.

### 2. Vercel

Import this repository with **Root Directory `./`** and **Framework Preset
"Other"**. Both matter:

- `vercel.json`, `api/`, and the workspace `package.json` all live at the
  repository root, so a Root Directory of `service` or `web` cannot see them -
  the build then produces either an API with no site or a site with no API.
- Choosing a framework preset makes Vercel override the build command and
  output directory from the dashboard, which silently supersedes `vercel.json`.

Then set two environment variables:

```
SUPABASE_URL         https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY  the secret / service_role key
```

`vercel.json` handles the rest. Vercel builds a Function from `api/[...path].ts`
and matches the filesystem - static assets and that Function - *before* any
rewrite, so `/api/*` resolves on its own and the catch-all rewrite only picks up
unmatched paths for client-side routing.

The Express package sits in `service/` rather than `api/` because Vercel compiles
every file under `api/` into its own Function; a package there would have had
each of its source files deployed as a separate endpoint.

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

`service/src/store/` holds a `PlotStore` interface with two implementations:

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
addon; a statically imported one would be bundled into the Function and loaded
on every cold start despite never being used. It is a devDependency for the same
reason.

If `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are missing on a serverless platform
the store refuses to start rather than falling back to a file. That fallback
looks healthy - plots save, the list populates - until the instance recycles and
every boundary someone drew is gone.

---

## Crop condition

Each plot is graded in fixed **3 m cells** on three indices, each split into the
same three zones so they read the same way:

| Index | Shown as | Critical (red) | Moderate (yellow) | Normal (green) |
|---|---|---|---|---|
| NDVI | Crop greenness | < 0.35 | 0.35 – 0.55 | ≥ 0.55 |
| NDRE | Crop vigour | < 0.20 | 0.20 – 0.35 | ≥ 0.35 |
| LSWI | Water stress | < 0.05 | 0.05 – 0.20 | ≥ 0.20 |

`GET /api/plots/:id/health` returns every cell with all three values and zones,
a per-index summary, and the **patches**: touching moderate-or-critical cells
(at least two), one per patch, ranked worst first per index. The field app turns
each patch into one drop point. The map grades **every saved plot at once**
(the *Crop condition* toggle is on by default): the moderate and critical cells
of the chosen index are painted yellow and red across all plots, each patch is a
drop point (click it for plot, zone, area and coordinate), and normal ground is
left unpainted, as in the camera. Switch the index with the Crop greenness /
Crop vigour / Water stress tabs; the panel sums the zones over every graded plot
and lists the drop points worst first.

Plots can be deleted from the Plots page or from the map (tap a plot, then
*Delete plot* in the Mark a plot panel). On Supabase this needs
`service/sql/004_delete_plot.sql`.

**The values are demonstration values.** `syntheticSamplers` is deterministic per
plot and shaped like a real field: a healthy body, one or two patches where the
canopy thins (NDVI and NDRE fall together), and a separate dry patch for LSWI.
Every response carries `synthetic: true` and the map says so. Wiring real
Sentinel-2 means replacing those samplers - nothing downstream knows where the
numbers came from.

There is no access point any more: the field app anchors on the nearest point of
a plot's boundary.

The map works on a phone: below 720 px the side panels become one bottom sheet
with a tab bar, and drawing has *Undo corner* and *Close shape* buttons in place
of right-click and double-click.

---

## Tests

```bash
npm run typecheck   # shared, api, web
npm run test:api    # end-to-end tests against the real Express app
npm run build
```

The API tests run the real app over HTTP against an in-memory SQLite database,
so they exercise the same validation, routing and `?near=` arithmetic that
ships.
