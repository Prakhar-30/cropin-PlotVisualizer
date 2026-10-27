-- =============================================================================
-- 004_delete_plot.sql
--
-- Lets the web tool delete one plot. Run once in the Supabase SQL editor after
-- 001-003. Additive: it creates one function and grants it; no data changes.
--
-- Health snapshots go with the plot (`on delete cascade` in 001); telemetry
-- rows keep their history with `plot_id` set to null (`on delete set null`).
-- =============================================================================

begin;

-- Returns whether a row was removed, so the API can answer 404 for an id that
-- never existed (or was already deleted) instead of a misleading success.
create or replace function public.fieldar_delete_plot(p_id text)
returns boolean
language sql
volatile
set search_path = fieldar, extensions, public
as $fn$
  with removed as (
    delete from fieldar.plots where id = p_id returning id
  )
  select exists (select 1 from removed);
$fn$;

revoke all on function public.fieldar_delete_plot(text) from public, anon, authenticated;
grant execute on function public.fieldar_delete_plot(text) to service_role;

commit;

-- verify: expect 1
select 'fieldar_delete_plot' as kind, count(*)::text as detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'fieldar_delete_plot';
