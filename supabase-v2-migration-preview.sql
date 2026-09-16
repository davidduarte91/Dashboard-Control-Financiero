-- Financial model v2 migration PREVIEW ONLY.
-- This file contains read-only diagnostic queries against v1. It creates no tables,
-- writes no rows, and should be reviewed with each user's actual data before any import.

-- v1 mapping, only when every dimension and the kind are recognized:
--   aporte     -> financial_position_movements(kind = 'contribution', amount)
--   retiro     -> financial_position_movements(kind = 'withdrawal', amount)
--   valuacion  -> financial_position_valuations(value = current_value)
-- Dimension dictionaries are built from trimmed non-empty v1 values plus financial_lists.
-- A generated v2 entity must retain the v1 `financial_entries.id` as `legacy_entry_id`.
-- The unique (user_id, legacy_entry_id) constraints make a later import idempotent.

with source_entries as (
  select
    e.id as legacy_entry_id,
    e.user_id,
    nullif(btrim(e.envelope), '') as envelope_name,
    nullif(btrim(e.investment), '') as investment_name,
    nullif(btrim(e.account), '') as account_name,
    e.currency,
    e.kind,
    e.amount,
    e.current_value,
    e.entry_date,
    e.created_at
  from public.financial_entries e
), classified as (
  select
    *,
    case
      when envelope_name is null or investment_name is null or account_name is null then 'manual_review_missing_dimension'
      when currency not in ('ARS', 'USD', 'USDT') then 'manual_review_invalid_currency'
      when kind not in ('aporte', 'retiro', 'valuacion') then 'manual_review_invalid_kind'
      when entry_date is null then 'manual_review_missing_date'
      when kind in ('aporte', 'retiro') and amount <= 0 then 'manual_review_invalid_movement_amount'
      when kind = 'valuacion' and current_value < 0 then 'manual_review_negative_valuation'
      when kind in ('aporte', 'retiro') and current_value <> 0 then 'review_current_value_not_migrated_as_event'
      when kind = 'valuacion' and amount <> 0 then 'review_amount_not_migrated_as_event'
      else 'automatic_candidate'
    end as migration_class
  from source_entries
)
select migration_class, count(*) as entries
from classified
group by migration_class
order by migration_class;

-- Inspect every record that must not be imported automatically, including
-- records whose unused v1 field makes their intended event ambiguous.
with source_entries as (
  select e.id as legacy_entry_id, e.user_id, nullif(btrim(e.envelope), '') as normalized_envelope,
    nullif(btrim(e.investment), '') as normalized_investment,
    nullif(btrim(e.account), '') as normalized_account, e.currency, e.kind,
    e.amount, e.current_value, e.entry_date, e.created_at
  from public.financial_entries e
), classified as (
  select *, case
    when normalized_envelope is null or normalized_investment is null or normalized_account is null then 'manual_review_missing_dimension'
    when currency not in ('ARS', 'USD', 'USDT') then 'manual_review_invalid_currency'
    when kind not in ('aporte', 'retiro', 'valuacion') then 'manual_review_invalid_kind'
    when entry_date is null then 'manual_review_missing_date'
    when kind in ('aporte', 'retiro') and amount <= 0 then 'manual_review_invalid_movement_amount'
    when kind = 'valuacion' and current_value < 0 then 'manual_review_negative_valuation'
    when kind in ('aporte', 'retiro') and current_value <> 0 then 'review_current_value_not_migrated_as_event'
    when kind = 'valuacion' and amount <> 0 then 'review_amount_not_migrated_as_event'
    else 'automatic_candidate'
  end as migration_class
  from source_entries
)
select legacy_entry_id, user_id, normalized_envelope, normalized_investment,
  normalized_account, currency, kind, amount, current_value, entry_date, created_at, migration_class
from classified
where migration_class <> 'automatic_candidate'
order by user_id, entry_date, created_at, legacy_entry_id;

-- Detect ambiguous same-date ordering. v1 has a date but no event time;
-- import must use a deterministic generated timestamp and event_sequence only after user approval.
select user_id, envelope, investment, account, currency, entry_date, count(*) as entries_on_same_day
from public.financial_entries
group by user_id, envelope, investment, account, currency, entry_date
having count(*) > 1
order by entries_on_same_day desc, user_id, entry_date;

-- Reconciliation baseline. Compare this with v2 results by user/currency after a dry run.
select user_id, currency,
  sum(case when kind = 'aporte' then amount else 0 end) as v1_contributions,
  sum(case when kind = 'retiro' then amount else 0 end) as v1_withdrawals,
  count(*) filter (where kind = 'valuacion') as v1_valuations,
  count(*) as v1_entries
from public.financial_entries
group by user_id, currency
order by user_id, currency;

-- financial_lists is a suggestions source only. It must never create a position by itself.
-- During import: union its trimmed values with names referenced by automatic candidates,
-- create only the three dictionaries, and archive unused list-only entries if retained.
select user_id,
  coalesce(array_length(envelopes, 1), 0) as listed_envelopes,
  coalesce(array_length(investments, 1), 0) as listed_investments,
  coalesce(array_length(accounts, 1), 0) as listed_accounts
from public.financial_lists
order by user_id;

-- Lists can contain whitespace-only or repeated labels. These do not create positions
-- automatically and must be normalized before deciding whether to retain them.
with list_values as (
  select user_id, 'envelope'::text as list_type, unnest(envelopes) as raw_name from public.financial_lists
  union all select user_id, 'investment', unnest(investments) from public.financial_lists
  union all select user_id, 'account', unnest(accounts) from public.financial_lists
)
select user_id, list_type, nullif(btrim(raw_name), '') as normalized_name, count(*) as occurrences
from list_values
group by user_id, list_type, nullif(btrim(raw_name), '')
having nullif(btrim(raw_name), '') is null or count(*) > 1
order by user_id, list_type, normalized_name;

-- Import plan (not executable here):
-- 1. Backup and run every preview query, preserving v1 as read-only source.
-- 2. Review every non-automatic result and every same-day ordering group.
-- 3. Create dictionaries and positions only from approved normalized dimensions.
-- 4. Insert events with legacy_entry_id using ON CONFLICT (user_id, legacy_entry_id) DO NOTHING.
-- 5. Assign a unique, increasing event_sequence per position and recompute chronologically:
--    movement before valuation at equal timestamps, then event_sequence within one type.
-- 6. Reconcile v1 event counts/totals and approved v2 snapshots; retain v1 until sign-off.
