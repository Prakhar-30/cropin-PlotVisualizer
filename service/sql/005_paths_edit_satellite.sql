-- =============================================================================
-- 005 - paths inside plots, editing plots, and a cache for satellite readings
-- =============================================================================
-- Run once in the Supabase SQL editor, after 001-004. Keeps every plot.
--
--   1. `exclusions`: walking paths and tracks inside a plot, as centre lines
--      with a width. Crop condition leaves their cells out, so a bare track is
--      not graded as failing crop.
--   2. `update_plot`: edit a plot's boundary, name, note and paths. The area is
--      recomputed by the API exactly as on create; the colour slot is kept.
--   3. `health_cache`: crop condition computed from Sentinel-2 is a few seconds
--      of downloads per plot, so the result is stored, keyed by the plot's
--      geometry and the satellite scene, and served from here next time.
--
-- One transaction: either all of it lands or none does.

begin;

-- -----------------------------------------------------------------------------
-- 1. the column
-- -----------------------------------------------------------------------------
alter table fieldar.plots
  add column if not exists exclusions jsonb not null default '[]'::jsonb;

-- -----------------------------------------------------------------------------
-- 2. everything that reads the plot row is rebuilt to carry it
-- -----------------------------------------------------------------------------
drop function if exists public.fieldar_create_plot(text, text, jsonb, double precision, text);
drop function if exists fieldar.create_plot(text, text, jsonb, double precision, text);
drop function if exists public.fieldar_plots_near(double precision, double precision, double precision);
drop function if exists fieldar.plots_near(double precision, double precision, double precision);
drop view if exists public.fieldar_plots;
drop view if exists fieldar.plots_api;

create view fieldar.plots_api as
select
  p.id,
  p.name,
  ST_AsGeoJSON(p.boundary)::jsonb                        as polygon,
  ST_Y(ST_Centroid(p.boundary::geometry))                as centroid_lat,
  ST_X(ST_Centroid(p.boundary::geometry))                as centroid_lng,
  p.area_sq_m,
  p.landmark_note,
  p.colour_index,
  p.exclusions,
  p.created_at,
  p.updated_at
from fieldar.plots p;

create function fieldar.plots_near(
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
  area_sq_m     double precision,
  landmark_note text,
  colour_index  smallint,
  exclusions    jsonb,
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

create function fieldar.create_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_area_sq_m     double precision,
  p_landmark_note text default '',
  p_exclusions    jsonb default '[]'::jsonb
)
returns setof fieldar.plots_api
language plpgsql
set search_path = fieldar, extensions, public
as $fn$
declare
  v_boundary geography(Polygon, 4326);
begin
  v_boundary := ST_SetSRID(ST_GeomFromGeoJSON(p_polygon::text), 4326)::geography;

  insert into fieldar.plots (id, name, boundary, area_sq_m, landmark_note, colour_index, exclusions)
  values (
    p_id,
    p_name,
    v_boundary,
    p_area_sq_m,
    coalesce(p_landmark_note, ''),
    fieldar.pick_colour_index(ST_Centroid(v_boundary::geometry)::geography),
    coalesce(p_exclusions, '[]'::jsonb)
  );

  return query select * from fieldar.plots_api where id = p_id;
end
$fn$;

-- Returns no row for an unknown id, so the API can answer 404.
create function fieldar.update_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_area_sq_m     double precision,
  p_landmark_note text default '',
  p_exclusions    jsonb default '[]'::jsonb
)
returns setof fieldar.plots_api
language plpgsql
set search_path = fieldar, extensions, public
as $fn$
begin
  update fieldar.plots
     set name          = p_name,
         boundary      = ST_SetSRID(ST_GeomFromGeoJSON(p_polygon::text), 4326)::geography,
         area_sq_m     = p_area_sq_m,
         landmark_note = coalesce(p_landmark_note, ''),
         exclusions    = coalesce(p_exclusions, '[]'::jsonb)
   where id = p_id;
  -- updated_at is set by the trg_plots_touch trigger from 001.
  return query select * from fieldar.plots_api where id = p_id;
end
$fn$;

-- -----------------------------------------------------------------------------
-- 3. the satellite cache
-- -----------------------------------------------------------------------------
create table if not exists fieldar.health_cache (
  plot_id    text        not null references fieldar.plots(id) on delete cascade,
  cache_key  text        not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (plot_id, cache_key)
);

create function public.fieldar_health_cache_get(p_plot_id text, p_cache_key text)
returns jsonb
language sql
stable
set search_path = fieldar, extensions, public
as $fn$
  select payload from fieldar.health_cache where plot_id = p_plot_id and cache_key = p_cache_key;
$fn$;

-- Keeps one entry per plot: a newer scene or an edited boundary replaces it.
create function public.fieldar_health_cache_put(p_plot_id text, p_cache_key text, p_payload jsonb)
returns void
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  delete from fieldar.health_cache where plot_id = p_plot_id and cache_key <> p_cache_key;
  insert into fieldar.health_cache (plot_id, cache_key, payload)
  values (p_plot_id, p_cache_key, p_payload)
  on conflict (plot_id, cache_key) do update set payload = excluded.payload, created_at = now();
$fn$;

-- -----------------------------------------------------------------------------
-- 4. public doorway (see 002 for why it exists)
-- -----------------------------------------------------------------------------
create view public.fieldar_plots
  with (security_invoker = true)
  as select * from fieldar.plots_api;

create function public.fieldar_plots_near(
  at_lat   double precision,
  at_lng   double precision,
  radius_m double precision default 5000
)
returns table (
  id            text,
  name          text,
  polygon       jsonb,
  centroid_lat  double precision,
  centroid_lng  double precision,
  area_sq_m     double precision,
  landmark_note text,
  colour_index  smallint,
  exclusions    jsonb,
  created_at    timestamptz,
  updated_at    timestamptz,
  distance_m    double precision
)
language sql
stable
set search_path = fieldar, extensions, public
as $fn$
  select * from fieldar.plots_near(at_lat, at_lng, radius_m);
$fn$;

create function public.fieldar_create_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_area_sq_m     double precision,
  p_landmark_note text default '',
  p_exclusions    jsonb default '[]'::jsonb
)
returns setof fieldar.plots_api
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  select * from fieldar.create_plot(p_id, p_name, p_polygon, p_area_sq_m, p_landmark_note, p_exclusions);
$fn$;

create function public.fieldar_update_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_area_sq_m     double precision,
  p_landmark_note text default '',
  p_exclusions    jsonb default '[]'::jsonb
)
returns setof fieldar.plots_api
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  select * from fieldar.update_plot(p_id, p_name, p_polygon, p_area_sq_m, p_landmark_note, p_exclusions);
$fn$;

-- -----------------------------------------------------------------------------
-- 5. grants
-- -----------------------------------------------------------------------------
grant select on fieldar.plots_api to anon, authenticated, service_role;
grant select on public.fieldar_plots to anon, authenticated, service_role;
grant execute on function public.fieldar_plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;
grant execute on function fieldar.plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;
-- Writes are service_role only.
revoke all on function public.fieldar_create_plot(text, text, jsonb, double precision, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.fieldar_update_plot(text, text, jsonb, double precision, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.fieldar_health_cache_put(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fieldar_health_cache_get(text, text) from public, anon, authenticated;
grant execute on function public.fieldar_create_plot(text, text, jsonb, double precision, text, jsonb)
  to service_role;
grant execute on function fieldar.create_plot(text, text, jsonb, double precision, text, jsonb)
  to service_role;
grant execute on function public.fieldar_update_plot(text, text, jsonb, double precision, text, jsonb)
  to service_role;
grant execute on function fieldar.update_plot(text, text, jsonb, double precision, text, jsonb)
  to service_role;
grant execute on function public.fieldar_health_cache_get(text, text) to service_role;
grant execute on function public.fieldar_health_cache_put(text, text, jsonb) to service_role;
grant all on fieldar.health_cache to service_role;

commit;

-- -----------------------------------------------------------------------------
-- verify: expect 1, 1, 1
-- -----------------------------------------------------------------------------
select 'exclusions column' as kind, count(*)::text as detail
  from information_schema.columns
 where table_schema = 'fieldar' and table_name = 'plots' and column_name = 'exclusions'
union all
select 'update function', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'fieldar_update_plot'
union all
select 'health cache table', count(*)::text
  from information_schema.tables
 where table_schema = 'fieldar' and table_name = 'health_cache';
