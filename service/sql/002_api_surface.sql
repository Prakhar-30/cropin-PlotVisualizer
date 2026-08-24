-- =============================================================================
-- Field AR - PostgREST surface  (migration 002)
--
-- Run this after 001. Same guarantees: idempotent, additive, and it never
-- drops, truncates or deletes anything.
--
-- Why this exists
-- ---------------
-- PostgREST only serves schemas listed in the project's "Exposed schemas"
-- setting, which defaults to `public`. Rather than make deployment depend on
-- someone remembering to add `fieldar` in the dashboard - a step that fails
-- silently, as a 404 on every request - the API surface is published as thin
-- wrappers in `public`. The data still lives in `fieldar`; only the doorway is
-- in `public`.
-- =============================================================================

set search_path to fieldar, extensions, public;

-- -----------------------------------------------------------------------------
-- 1. reject self-intersecting boundaries in the database itself
-- -----------------------------------------------------------------------------
-- `validatePlotInput()` in @plot/shared already rejects a bowtie before it
-- reaches here, but that check only protects the path that goes through the
-- Node API. A constraint protects every path, including a client talking to
-- PostgREST directly and anything written by hand in the SQL editor.
--
-- Added NOT VALID first so the statement cannot fail on pre-existing rows, then
-- validated separately - if an old row is bad, that surfaces as its own clear
-- error rather than as a migration that half-applied.
do $add_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'plots_boundary_simple' and conrelid = 'fieldar.plots'::regclass
  ) then
    alter table fieldar.plots
      add constraint plots_boundary_simple
      check (ST_IsValid(boundary::geometry)) not valid;
  end if;
end
$add_check$;

alter table fieldar.plots validate constraint plots_boundary_simple;


-- -----------------------------------------------------------------------------
-- 2. create a plot
-- -----------------------------------------------------------------------------
-- The boundary arrives as GeoJSON and is converted here, so the lng/lat order
-- and the SRID are decided in one place. The colour slot is chosen server-side
-- for the same reason ids are: a client should not get to pick it.
create or replace function fieldar.create_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_access_lat    double precision,
  p_access_lng    double precision,
  p_area_sq_m     double precision,
  p_landmark_note text default ''
)
returns setof fieldar.plots_api
language plpgsql
set search_path = fieldar, extensions, public
as $fn$
declare
  v_boundary geography(Polygon, 4326);
  v_access   geography(Point, 4326);
begin
  v_boundary := ST_SetSRID(ST_GeomFromGeoJSON(p_polygon::text), 4326)::geography;
  v_access   := ST_SetSRID(ST_MakePoint(p_access_lng, p_access_lat), 4326)::geography;

  insert into fieldar.plots
    (id, name, boundary, access_point, area_sq_m, landmark_note, colour_index)
  values (
    p_id,
    p_name,
    v_boundary,
    v_access,
    p_area_sq_m,
    coalesce(p_landmark_note, ''),
    fieldar.pick_colour_index(ST_Centroid(v_boundary::geometry)::geography)
  );

  return query select * from fieldar.plots_api where id = p_id;
end
$fn$;


-- -----------------------------------------------------------------------------
-- 3. public doorway
-- -----------------------------------------------------------------------------
-- `security_invoker` so the view respects the caller's own row-level security
-- rather than silently running as its owner. The API uses the secret key and so
-- bypasses RLS anyway; this keeps an anon caller correctly constrained.
create or replace view public.fieldar_plots
  with (security_invoker = true)
  as select * from fieldar.plots_api;

-- The column list is spelled out rather than written as `setof
-- fieldar.plots_near`. A `RETURNS TABLE` function does not create a named
-- composite type - only tables and views do - so referring to one by name fails
-- with `type "fieldar.plots_near" does not exist`. `fieldar.plots_api` below is
-- a view, which is why *that* one can be named directly.
create or replace function public.fieldar_plots_near(
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
  select * from fieldar.plots_near(at_lat, at_lng, radius_m);
$fn$;

create or replace function public.fieldar_create_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_access_lat    double precision,
  p_access_lng    double precision,
  p_area_sq_m     double precision,
  p_landmark_note text default ''
)
returns setof fieldar.plots_api
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  select * from fieldar.create_plot(
    p_id, p_name, p_polygon, p_access_lat, p_access_lng, p_area_sq_m, p_landmark_note
  );
$fn$;

-- Used only by the seed script, which rebuilds the demo set from scratch. It is
-- the one destructive operation in the project, it is not reachable by `anon`,
-- and it is scoped to this schema's own table.
create or replace function public.fieldar_delete_all_plots()
returns void
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  delete from fieldar.plots;
$fn$;


-- -----------------------------------------------------------------------------
-- 4. grants
-- -----------------------------------------------------------------------------
grant select on public.fieldar_plots to anon, authenticated, service_role;

grant execute on function public.fieldar_plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;

-- Writes are service_role only: the publishable key ships inside the APK.
grant execute on function public.fieldar_create_plot(
  text, text, jsonb, double precision, double precision, double precision, text
) to service_role;
grant execute on function public.fieldar_delete_all_plots() to service_role;
grant execute on function fieldar.create_plot(
  text, text, jsonb, double precision, double precision, double precision, text
) to service_role;


-- -----------------------------------------------------------------------------
-- 5. verify
-- -----------------------------------------------------------------------------
select 'public functions' as kind, count(*)::text as detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'fieldar_%'
union all
select 'public views', count(*)::text
  from information_schema.views where table_schema = 'public' and table_name like 'fieldar_%'
union all
select 'plots', count(*)::text from fieldar.plots;
