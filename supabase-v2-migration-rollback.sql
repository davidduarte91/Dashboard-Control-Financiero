-- Controlled rollback for v1_to_v2_approved_2026_09_17. REVIEW ONLY: DO NOT EXECUTE YET.
-- Run only while v1 remains frozen and after confirming no post-migration v2 writes exist.
begin;
do $$ begin
  if exists (select 1 from public.financial_position_movements where legacy_entry_id is null)
     or exists (select 1 from public.financial_position_valuations where legacy_entry_id is null)
     or exists (select 1 from public.financial_position_adjustments)
     or exists (select 1 from public.financial_positions where id not in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='position')) then
    raise exception 'ROLLBACK_ABORTED_NON_MIGRATION_V2_EVENTS_EXIST';
  end if;
end $$;
delete from public.financial_position_valuations where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='valuation');
delete from public.financial_position_movements where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='movement');
delete from public.financial_position_snapshots where position_id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='position');
delete from public.financial_positions where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='position') and not exists (select 1 from public.financial_position_movements m where m.position_id=financial_positions.id) and not exists (select 1 from public.financial_position_valuations v where v.position_id=financial_positions.id);
delete from public.financial_envelopes where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='envelope') and not exists (select 1 from public.financial_positions p where p.envelope_id=financial_envelopes.id);
delete from public.financial_investments where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='investment') and not exists (select 1 from public.financial_positions p where p.investment_id=financial_investments.id);
delete from public.financial_accounts where id in (select object_id from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='account') and not exists (select 1 from public.financial_positions p where p.account_id=financial_accounts.id);
delete from public.financial_v2_migration_legacy_exclusions where migration_key='v1_to_v2_approved_2026_09_17';
do $$ begin
  if (select count(*) from public.financial_positions) <> 0 or (select count(*) from public.financial_position_movements) <> 0 or (select count(*) from public.financial_position_valuations) <> 0 or (select count(*) from public.financial_position_snapshots) <> 0 then raise exception 'ROLLBACK_INCOMPLETE_V2_DATA_REMAINS'; end if;
  if exists (select 1 from public.financial_v2_migration_objects o join public.financial_envelopes e on e.id=o.object_id where o.migration_key='v1_to_v2_approved_2026_09_17' and o.object_type='envelope')
    or exists (select 1 from public.financial_v2_migration_objects o join public.financial_investments i on i.id=o.object_id where o.migration_key='v1_to_v2_approved_2026_09_17' and o.object_type='investment')
    or exists (select 1 from public.financial_v2_migration_objects o join public.financial_accounts a on a.id=o.object_id where o.migration_key='v1_to_v2_approved_2026_09_17' and o.object_type='account') then raise exception 'ROLLBACK_INCOMPLETE_TRACKED_CATALOG_REMAINS'; end if;
  if (select count(*) from public.financial_entries) <> 26 or (select coalesce(sum(amount),0) from public.financial_entries where kind='aporte' and currency='ARS') <> 1781702.93 or (select coalesce(sum(amount),0) from public.financial_entries where kind='aporte' and currency='USD') <> 330.78 then raise exception 'ROLLBACK_V1_INTEGRITY_CHECK_FAILED'; end if;
end $$;
delete from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17';
delete from public.financial_v2_migration_runs where migration_key='v1_to_v2_approved_2026_09_17';
do $$ begin if exists (select 1 from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17') then raise exception 'ROLLBACK_MIGRATION_OBJECTS_REMAIN'; end if; end $$;
commit;
