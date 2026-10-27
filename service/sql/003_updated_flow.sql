-- =============================================================================
-- 003 - the updated flow: no access point, three-zone crop condition, fresh start
-- =============================================================================
-- Run once in the Supabase SQL editor, after 001 and 002.
--
--   1. WIPES every plot (and, by cascade, every stored health snapshot). The
--      updated flow starts from a clean slate by decision; plots are redrawn in
--      the web tool.
--   2. Removes the access point. The field app now anchors on the nearest
--      point of the plot boundary itself, so a separately surveyed point is no
--      longer needed - and a required column nobody fills is a form nobody can
--      submit.
--   3. Narrows stored zones to 0 normal / 1 moderate / 2 critical, the same
--      three zones used for NDVI, NDRE and LSWI.
--
-- Wrapped in one transaction: either the whole change lands or none of it does.

begin;

-- -----------------------------------------------------------------------------
-- 1. everything that reads access_point goes first
-- -----------------------------------------------------------------------------
drop function if exists public.fieldar_create_plot(
  text, text, jsonb, double precision, double precision, double precision, text);
drop function if exists fieldar.create_plot(
  text, text, jsonb, double precision, double precision, double precision, text);
drop function if exists public.fieldar_plots_near(double precision, double precision, double precision);
drop function if exists fieldar.plots_near(double precision, double precision, double precision);
drop view if exists public.fieldar_plots;
drop view if exists fieldar.plots_api;

-- -----------------------------------------------------------------------------
-- 2. wipe, then drop the column
-- -----------------------------------------------------------------------------
-- `where id is not null` satisfies Supabase's safeupdate guard without
-- changing what is removed.
delete from fieldar.plots where id is not null;

alter table fieldar.plots drop column if exists access_point;

-- -----------------------------------------------------------------------------
-- 3. three zones
-- -----------------------------------------------------------------------------
alter table fieldar.health_cells drop constraint if exists health_cells_severity;
alter table fieldar.health_cells
  add constraint health_cells_severity check (severity between 0 and 2);
alter table fieldar.health_hotspots drop constraint if exists health_hotspots_severity;
alter table fieldar.health_hotspots
  add constraint health_hotspots_severity check (severity between 0 and 2);

-- -----------------------------------------------------------------------------
-- 4. the read surface, without the access point
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 5. create a plot, without the access point
-- -----------------------------------------------------------------------------
create function fieldar.create_plot(
  p_id            text,
  p_name          text,
  p_polygon       jsonb,
  p_area_sq_m     double precision,
  p_landmark_note text default ''
)
returns setof fieldar.plots_api
language plpgsql
set search_path = fieldar, extensions, public
as $fn$
declare
  v_boundary geography(Polygon, 4326);
begin
  v_boundary := ST_SetSRID(ST_GeomFromGeoJSON(p_polygon::text), 4326)::geography;

  insert into fieldar.plots (id, name, boundary, area_sq_m, landmark_note, colour_index)
  values (
    p_id,
    p_name,
    v_boundary,
    p_area_sq_m,
    coalesce(p_landmark_note, ''),
    fieldar.pick_colour_index(ST_Centroid(v_boundary::geometry)::geography)
  );

  return query select * from fieldar.plots_api where id = p_id;
end
$fn$;

-- -----------------------------------------------------------------------------
-- 6. public doorway (see 002 for why it exists)
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
  p_landmark_note text default ''
)
returns setof fieldar.plots_api
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  select * from fieldar.create_plot(p_id, p_name, p_polygon, p_area_sq_m, p_landmark_note);
$fn$;

-- -----------------------------------------------------------------------------
-- 7. grants (the views and functions above are new objects)
-- -----------------------------------------------------------------------------
grant select on fieldar.plots_api to anon, authenticated, service_role;
grant select on public.fieldar_plots to anon, authenticated, service_role;
grant execute on function public.fieldar_plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;
grant execute on function fieldar.plots_near(double precision, double precision, double precision)
  to anon, authenticated, service_role;
-- Writes are service_role only.
grant execute on function public.fieldar_create_plot(text, text, jsonb, double precision, text)
  to service_role;
grant execute on function fieldar.create_plot(text, text, jsonb, double precision, text)
  to service_role;

commit;

-- -----------------------------------------------------------------------------
-- 8. verify: expect 0 plots and no access_point column
-- -----------------------------------------------------------------------------
select 'plots' as kind, count(*)::text as detail from fieldar.plots
union all
select 'access_point column', count(*)::text
  from information_schema.columns
 where table_schema = 'fieldar' and table_name = 'plots' and column_name = 'access_point';
