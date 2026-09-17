-- Controlled rollback for v1_to_v2_approved_2026_09_17. REVIEW ONLY: DO NOT EXECUTE YET.
-- Run only while v1 remains frozen and after confirming no post-migration v2 writes exist.
begin;
do $$ begin
  if exists (select 1 from public.financial_position_movements where legacy_entry_id is null)
     or exists (select 1 from public.financial_position_valuations where legacy_entry_id is null)
     or exists (select 1 from public.financial_position_adjustments) then
    raise exception 'ROLLBACK_ABORTED_NON_MIGRATION_V2_EVENTS_EXIST';
  end if;
end $$;
delete from public.financial_position_valuations where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='valuation');
delete from public.financial_position_movements where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='movement');
delete from public.financial_position_snapshots where position_id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='position');
delete from public.financial_positions where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='position') and not exists (select 1 from public.financial_position_movements m where m.position_id=financial_positions.id) and not exists (select 1 from public.financial_position_valuations v where v.position_id=financial_positions.id);
-- Catalog items are intentionally retained: deleting an empty name cannot prove it was
-- created by this migration after later administrative activity.
delete from public.financial_v2_migration_legacy_exclusions where migration_key='v1_to_v2_approved_2026_09_17';
delete from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17';
delete from public.financial_v2_migration_runs where migration_key='v1_to_v2_approved_2026_09_17';
commit;
