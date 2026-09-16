-- Financial model v2: PROPOSAL ONLY.
-- Do not run this file until its migration plan and RLS review are approved.
-- It deliberately leaves financial_entries and financial_lists unchanged.

begin;

create table public.financial_envelopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_envelopes_name_normalized check (name = btrim(name) and name <> ''),
  constraint financial_envelopes_id_user_unique unique (id, user_id)
);

create table public.financial_investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_investments_name_normalized check (name = btrim(name) and name <> ''),
  constraint financial_investments_id_user_unique unique (id, user_id)
);

create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_accounts_name_normalized check (name = btrim(name) and name <> ''),
  constraint financial_accounts_id_user_unique unique (id, user_id)
);

-- The exact fund location: envelope + investment + account + native currency.
create table public.financial_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  envelope_id uuid not null,
  investment_id uuid not null,
  account_id uuid not null,
  currency text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_positions_currency_valid check (currency in ('ARS', 'USD', 'USDT')),
  constraint financial_positions_envelope_owner_fk
    foreign key (envelope_id, user_id) references public.financial_envelopes (id, user_id) on delete restrict,
  constraint financial_positions_investment_owner_fk
    foreign key (investment_id, user_id) references public.financial_investments (id, user_id) on delete restrict,
  constraint financial_positions_account_owner_fk
    foreign key (account_id, user_id) references public.financial_accounts (id, user_id) on delete restrict,
  constraint financial_positions_id_user_unique unique (id, user_id),
  constraint financial_positions_location_unique unique (user_id, envelope_id, investment_id, account_id, currency)
);

-- amount is always positive. kind determines its direction.
-- legacy_entry_id makes a later v1 import idempotent without changing v1.
create table public.financial_position_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  position_id uuid not null,
  kind text not null,
  amount numeric(20, 2) not null,
  occurred_at timestamptz not null,
  -- Allocated under the position row lock; provides a stable tie-breaker.
  event_sequence bigint not null,
  legacy_entry_id uuid,
  transfer_id uuid,
  reversal_of_movement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_position_movements_position_owner_fk
    foreign key (position_id, user_id) references public.financial_positions (id, user_id) on delete restrict,
  constraint financial_position_movements_id_user_unique unique (id, user_id),
  constraint financial_position_movements_reversal_owner_fk
    foreign key (reversal_of_movement_id, user_id)
    references public.financial_position_movements (id, user_id) on delete restrict,
  constraint financial_position_movements_kind_valid check (kind in ('contribution', 'withdrawal')),
  constraint financial_position_movements_amount_positive check (amount > 0),
  constraint financial_position_movements_sequence_positive check (event_sequence > 0),
  constraint financial_position_movements_not_self_reversal
    check (reversal_of_movement_id is null or reversal_of_movement_id <> id),
  constraint financial_position_movements_legacy_entry_unique unique (user_id, legacy_entry_id)
);

-- Valuations state the complete native-currency value at valued_at. They may be retroactive.
create table public.financial_position_valuations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  position_id uuid not null,
  value numeric(20, 2) not null,
  valued_at timestamptz not null,
  -- Allocated under the position row lock; later sequence wins among valuations at one instant.
  event_sequence bigint not null,
  source text not null default 'manual',
  legacy_entry_id uuid,
  reversal_of_valuation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_position_valuations_position_owner_fk
    foreign key (position_id, user_id) references public.financial_positions (id, user_id) on delete restrict,
  constraint financial_position_valuations_id_user_unique unique (id, user_id),
  constraint financial_position_valuations_reversal_owner_fk
    foreign key (reversal_of_valuation_id, user_id)
    references public.financial_position_valuations (id, user_id) on delete restrict,
  constraint financial_position_valuations_value_nonnegative check (value >= 0),
  constraint financial_position_valuations_sequence_positive check (event_sequence > 0),
  constraint financial_position_valuations_source_valid check (source in ('manual', 'imported', 'market')),
  constraint financial_position_valuations_not_self_reversal
    check (reversal_of_valuation_id is null or reversal_of_valuation_id <> id),
  constraint financial_position_valuations_legacy_entry_unique unique (user_id, legacy_entry_id)
);

-- Rebuildable cache. The immutable event ledger remains the source of truth.
create table public.financial_position_snapshots (
  position_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  revision bigint not null default 0 check (revision >= 0),
  current_value numeric(20, 2) not null check (current_value >= 0),
  historical_contributions numeric(20, 2) not null check (historical_contributions >= 0),
  historical_withdrawals numeric(20, 2) not null check (historical_withdrawals >= 0),
  capital_withdrawn numeric(20, 2) not null check (capital_withdrawn >= 0),
  remaining_capital numeric(20, 2) not null check (remaining_capital >= 0),
  realized_gain numeric(20, 2) not null,
  realized_loss numeric(20, 2) not null check (realized_loss <= 0),
  realized_performance numeric(20, 2) not null,
  unrealized_performance numeric(20, 2) not null,
  historical_performance numeric(20, 2) not null,
  last_valuation_at timestamptz,
  computed_at timestamptz not null default now(),
  constraint financial_position_snapshots_position_owner_fk
    foreign key (position_id, user_id) references public.financial_positions (id, user_id) on delete restrict,
  constraint financial_position_snapshots_id_user_unique unique (position_id, user_id),
  constraint financial_position_snapshots_realized_performance_check
    check (realized_performance = realized_gain + realized_loss),
  constraint financial_position_snapshots_historical_performance_check
    check (historical_performance = realized_performance + unrealized_performance)
);

-- A committed request stores its exact prior response so retries are side-effect free.
create table public.financial_position_write_requests (
  user_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  position_id uuid not null,
  operation text not null,
  request_fingerprint text not null,
  -- NULL exists only within the writer transaction while the request is in progress.
  response jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, request_id),
  constraint financial_position_write_requests_position_owner_fk
    foreign key (position_id, user_id) references public.financial_positions (id, user_id) on delete restrict,
  constraint financial_position_write_requests_operation_valid
    check (operation in ('contribution', 'withdrawal', 'valuation', 'reverse_movement', 'correct_valuation')),
  constraint financial_position_write_requests_fingerprint_not_blank check (btrim(request_fingerprint) <> '')
);

-- Archived catalog items retain their history but release their name for a new active item.
create unique index financial_envelopes_active_name_unique_idx on public.financial_envelopes (user_id, name) where archived_at is null;
create unique index financial_investments_active_name_unique_idx on public.financial_investments (user_id, name) where archived_at is null;
create unique index financial_accounts_active_name_unique_idx on public.financial_accounts (user_id, name) where archived_at is null;
create index financial_positions_active_by_user_idx on public.financial_positions (user_id, archived_at) where archived_at is null;
create index financial_position_movements_replay_idx on public.financial_position_movements (user_id, position_id, occurred_at, event_sequence);
create index financial_position_valuations_replay_idx on public.financial_position_valuations (user_id, position_id, valued_at, event_sequence);
create unique index financial_position_movements_one_reversal_idx on public.financial_position_movements (reversal_of_movement_id) where reversal_of_movement_id is not null;
create unique index financial_position_valuations_one_reversal_idx on public.financial_position_valuations (reversal_of_valuation_id) where reversal_of_valuation_id is not null;
create index financial_position_snapshots_user_idx on public.financial_position_snapshots (user_id, computed_at desc);
create index financial_position_write_requests_position_idx on public.financial_position_write_requests (user_id, position_id, created_at desc);

create or replace function public.set_financial_v2_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger financial_envelopes_set_updated_at before update on public.financial_envelopes
for each row execute function public.set_financial_v2_updated_at();
create trigger financial_investments_set_updated_at before update on public.financial_investments
for each row execute function public.set_financial_v2_updated_at();
create trigger financial_accounts_set_updated_at before update on public.financial_accounts
for each row execute function public.set_financial_v2_updated_at();
create trigger financial_positions_set_updated_at before update on public.financial_positions
for each row execute function public.set_financial_v2_updated_at();
create trigger financial_position_movements_set_updated_at before update on public.financial_position_movements
for each row execute function public.set_financial_v2_updated_at();
create trigger financial_position_valuations_set_updated_at before update on public.financial_position_valuations
for each row execute function public.set_financial_v2_updated_at();

alter table public.financial_envelopes enable row level security;
alter table public.financial_investments enable row level security;
alter table public.financial_accounts enable row level security;
alter table public.financial_positions enable row level security;
alter table public.financial_position_movements enable row level security;
alter table public.financial_position_valuations enable row level security;
alter table public.financial_position_snapshots enable row level security;
alter table public.financial_position_write_requests enable row level security;

grant select, insert, update on table public.financial_envelopes to authenticated;
grant select, insert, update on table public.financial_investments to authenticated;
grant select, insert, update on table public.financial_accounts to authenticated;
grant select, insert, update on table public.financial_positions to authenticated;
grant select on table public.financial_position_movements to authenticated;
grant select on table public.financial_position_valuations to authenticated;
grant select on table public.financial_position_snapshots to authenticated;

revoke delete on table public.financial_envelopes from anon, authenticated;
revoke delete on table public.financial_investments from anon, authenticated;
revoke delete on table public.financial_accounts from anon, authenticated;
revoke delete on table public.financial_positions from anon, authenticated;
revoke delete on table public.financial_position_movements from anon, authenticated;
revoke delete on table public.financial_position_valuations from anon, authenticated;
revoke insert, update, delete on table public.financial_position_movements from anon, authenticated;
revoke insert, update, delete on table public.financial_position_valuations from anon, authenticated;
revoke insert, update, delete on table public.financial_position_snapshots from anon, authenticated;
revoke all on table public.financial_position_write_requests from anon, authenticated;

-- No DELETE grants or policies: preserve financial history. Archiving is an UPDATE.
create policy "financial_envelopes_select_owner" on public.financial_envelopes for select to authenticated using (user_id = auth.uid());
create policy "financial_envelopes_insert_owner" on public.financial_envelopes for insert to authenticated with check (user_id = auth.uid());
create policy "financial_envelopes_update_owner" on public.financial_envelopes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "financial_investments_select_owner" on public.financial_investments for select to authenticated using (user_id = auth.uid());
create policy "financial_investments_insert_owner" on public.financial_investments for insert to authenticated with check (user_id = auth.uid());
create policy "financial_investments_update_owner" on public.financial_investments for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "financial_accounts_select_owner" on public.financial_accounts for select to authenticated using (user_id = auth.uid());
create policy "financial_accounts_insert_owner" on public.financial_accounts for insert to authenticated with check (user_id = auth.uid());
create policy "financial_accounts_update_owner" on public.financial_accounts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "financial_positions_select_owner" on public.financial_positions for select to authenticated using (user_id = auth.uid());
create policy "financial_positions_insert_owner" on public.financial_positions for insert to authenticated with check (user_id = auth.uid());
create policy "financial_positions_update_owner" on public.financial_positions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "financial_position_movements_select_owner" on public.financial_position_movements for select to authenticated using (user_id = auth.uid());
create policy "financial_position_valuations_select_owner" on public.financial_position_valuations for select to authenticated using (user_id = auth.uid());
create policy "financial_position_snapshots_select_owner" on public.financial_position_snapshots for select to authenticated using (user_id = auth.uid());

commit;
