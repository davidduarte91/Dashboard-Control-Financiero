-- v1 -> v2 APPROVED MIGRATION PLAN. REVIEW ONLY: DO NOT EXECUTE YET.
-- Prerequisites: v1 writes frozen; supabase-v2-schema.sql and supabase-v2-rpc-design.sql deployed.
-- This script never updates/deletes financial_entries or financial_lists.

begin;

create table if not exists public.financial_v2_migration_runs (
  migration_key text primary key,
  source_entries_count integer not null,
  created_at timestamptz not null default now()
);
create table if not exists public.financial_v2_migration_objects (
  migration_key text not null references public.financial_v2_migration_runs(migration_key) on delete restrict,
  object_type text not null check (object_type in ('envelope','investment','account','position','movement','valuation')),
  object_id uuid not null,
  user_id uuid not null,
  primary key (migration_key, object_type, object_id)
);
create table if not exists public.financial_v2_migration_legacy_exclusions (
  migration_key text not null references public.financial_v2_migration_runs(migration_key) on delete restrict,
  legacy_entry_id uuid not null,
  classification text not null check (classification = 'aggregate_multi_envelope_valuation'),
  reason text not null,
  primary key (migration_key, legacy_entry_id)
);

-- Prechecks: abort before any v2 financial rows are created when the approved source changed.
do $$
declare v_entries integer; v_contributions integer; v_valuations integer; v_ars numeric; v_usd numeric; v_withdrawals integer;
begin
  select count(*), count(*) filter (where kind = 'aporte'), count(*) filter (where kind = 'valuacion'),
    coalesce(sum(amount) filter (where kind = 'aporte' and currency = 'ARS'),0),
    coalesce(sum(amount) filter (where kind = 'aporte' and currency = 'USD'),0),
    count(*) filter (where kind = 'retiro')
  into v_entries, v_contributions, v_valuations, v_ars, v_usd, v_withdrawals from public.financial_entries;
  if v_entries <> 26 or v_contributions <> 22 or v_valuations <> 4 or v_withdrawals <> 0
    or v_ars <> 1781702.93 or v_usd <> 330.78 then
    raise exception 'V1_APPROVED_RECONCILIATION_CHANGED';
  end if;
  if exists (select 1 from public.financial_envelopes)
    or exists (select 1 from public.financial_investments)
    or exists (select 1 from public.financial_accounts)
    or exists (select 1 from public.financial_positions)
    or exists (select 1 from public.financial_position_movements)
    or exists (select 1 from public.financial_position_valuations)
    or exists (select 1 from public.financial_position_adjustments)
    or exists (select 1 from public.financial_position_snapshots) then
    raise exception 'V2_NOT_EMPTY_ABORT_FOR_SAFE_FIRST_IMPORT';
  end if;
  if exists (select 1 from public.financial_entries where kind = 'aporte' and (amount <= 0 or current_value <> amount or btrim(envelope) = '' or btrim(investment) = '' or btrim(account) = '')) then
    raise exception 'V1_CONTRIBUTION_SHAPE_CHANGED';
  end if;
  if exists (
    with expected(envelope,investment,account,currency,entry_count,total) as (values
      ('Mantenimiento auto','SBS RTA PESOS','Brubank','ARS',2,18345.00::numeric),
      ('Tarjeta credito Octubre','SBS RTA PESOS','Brubank','ARS',1,129880.13::numeric),
      ('Ahorro David','Acciones argentinas','Brubank','ARS',1,109181.00::numeric),
      ('Ahorro David','Cedears','Brubank','ARS',2,814105.87::numeric),
      ('Ahorro David','SBS RTA FIJA','Brubank','ARS',1,21000.00::numeric),
      ('Vacaciones','SBS RTA PESOS','Brubank','ARS',2,19626.47::numeric),
      ('Ahorro David','SBS RTA PESOS','Brubank','ARS',1,246066.10::numeric),
      ('Tarjeta credito Septiembre','SBS RTA PESOS','Brubank','ARS',3,423498.36::numeric),
      ('Ahorro David','Acciones lemon','Lemon','USD',7,262.80::numeric),
      ('Ahorro David','Criptomonedas','Lemon','USD',2,67.98::numeric)
    ), actual as (
      select btrim(envelope) envelope,btrim(investment) investment,btrim(account) account,currency,count(*) entry_count,sum(amount) total
      from public.financial_entries where kind='aporte' group by 1,2,3,4
    ) select 1 from expected e full join actual a using(envelope,investment,account,currency)
    where coalesce(e.entry_count,-1)<>coalesce(a.entry_count,-1) or coalesce(e.total,-1)<>coalesce(a.total,-1)
  ) then raise exception 'V1_POSITION_LEVEL_RECONCILIATION_CHANGED'; end if;
  if (select count(*) from public.financial_entries where id in (
    'd86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688'
  ) and kind='valuacion' and amount=0 and currency='ARS' and btrim(envelope)='') <> 3 then raise exception 'APPROVED_VALUATIONS_CHANGED'; end if;
  if not exists (select 1 from public.financial_entries where id='102bd81b-d7c4-45e8-86a8-c56305cdf03e' and kind='valuacion' and amount=0 and current_value=625833.41 and btrim(envelope)='' and investment='SBS RTA PESOS' and account='Brubank' and currency='ARS') then
    raise exception 'AGGREGATE_LEGACY_VALUATION_CHANGED';
  end if;
end $$;

insert into public.financial_v2_migration_runs (migration_key, source_entries_count)
values ('v1_to_v2_approved_2026_09_17', 26)
on conflict (migration_key) do nothing;

-- Map only approved source rows. created_at determines event_sequence only within
-- same-business-date contribution groups; occurred_at is midnight Buenos Aires in UTC.
with mapped as (
  select e.id legacy_entry_id, e.user_id,
    case when e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688') then 'Ahorro David' else btrim(e.envelope) end envelope,
    btrim(e.investment) investment, btrim(e.account) account, e.currency, e.kind, e.amount, e.current_value, e.entry_date, e.created_at,
    case when e.kind='aporte' then 1 else 2 end event_type
  from public.financial_entries e
  where (e.kind='aporte' and e.current_value=e.amount)
     or e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688')
), dimensions as (
  select distinct user_id, envelope, investment, account from mapped
), inserted as (
  insert into public.financial_envelopes (user_id,name) select user_id,envelope from dimensions on conflict do nothing returning id,user_id
) insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
  select 'v1_to_v2_approved_2026_09_17','envelope',id,user_id from inserted on conflict do nothing;
with mapped as (
  select e.user_id, case when e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688') then 'Ahorro David' else btrim(e.envelope) end envelope, btrim(e.investment) investment, btrim(e.account) account
  from public.financial_entries e where e.kind='aporte' or e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688')
), inserted as (
  insert into public.financial_investments (user_id,name) select distinct user_id,investment from mapped on conflict do nothing returning id,user_id
) insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
  select 'v1_to_v2_approved_2026_09_17','investment',id,user_id from inserted on conflict do nothing;
with mapped as (
  select e.user_id, case when e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688') then 'Ahorro David' else btrim(e.envelope) end envelope, btrim(e.investment) investment, btrim(e.account) account
  from public.financial_entries e where e.kind='aporte' or e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688')
), inserted as (
  insert into public.financial_accounts (user_id,name) select distinct user_id,account from mapped on conflict do nothing returning id,user_id
) insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
  select 'v1_to_v2_approved_2026_09_17','account',id,user_id from inserted on conflict do nothing;

with mapped as (
  select e.id legacy_entry_id, e.user_id,
    case when e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688') then 'Ahorro David' else btrim(e.envelope) end envelope,
    btrim(e.investment) investment, btrim(e.account) account, e.currency
  from public.financial_entries e where e.kind='aporte' or e.id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688')
)
insert into public.financial_positions (user_id,envelope_id,investment_id,account_id,currency)
select distinct m.user_id,en.id,i.id,a.id,m.currency from mapped m
join public.financial_envelopes en on (en.user_id,en.name)=(m.user_id,m.envelope) and en.archived_at is null
join public.financial_investments i on (i.user_id,i.name)=(m.user_id,m.investment) and i.archived_at is null
join public.financial_accounts a on (a.user_id,a.name)=(m.user_id,m.account) and a.archived_at is null
on conflict do nothing;

with mapped as (
  select e.*, btrim(envelope) envelope_name,btrim(investment) investment_name,btrim(account) account_name,
    row_number() over (partition by e.user_id,btrim(envelope),btrim(investment),btrim(account),currency order by entry_date,created_at,id) event_sequence
  from public.financial_entries e where kind='aporte' and current_value=amount
)
insert into public.financial_position_movements (user_id,position_id,kind,amount,occurred_at,event_sequence,legacy_entry_id)
select m.user_id,p.id,'contribution',m.amount,(m.entry_date::timestamp at time zone 'America/Argentina/Buenos_Aires'),m.event_sequence,m.id
from mapped m join public.financial_positions p on p.user_id=m.user_id and p.currency=m.currency
join public.financial_envelopes en on en.id=p.envelope_id and en.name=m.envelope_name
join public.financial_investments i on i.id=p.investment_id and i.name=m.investment_name
join public.financial_accounts a on a.id=p.account_id and a.name=m.account_name
on conflict (user_id,legacy_entry_id) do nothing;

insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
select 'v1_to_v2_approved_2026_09_17','movement',id,user_id from public.financial_position_movements where legacy_entry_id is not null
on conflict do nothing;

with mapped as (
  select e.*, 'Ahorro David' envelope_name, btrim(investment) investment_name,btrim(account) account_name
  from public.financial_entries e where id in ('d86b3a8a-4042-4962-ad39-0c894c08263c','577a29e7-52f2-4f59-a260-df73f19ed793','0233822a-83ac-4048-aa7b-92f290ae8688')
)
insert into public.financial_position_valuations (user_id,position_id,value,valued_at,event_sequence,source,legacy_entry_id)
select m.user_id,p.id,m.current_value,(m.entry_date::timestamp at time zone 'America/Argentina/Buenos_Aires'),
  coalesce((select max(event_sequence) from public.financial_position_movements x where x.position_id=p.id),0)+1,'imported',m.id
from mapped m join public.financial_positions p on p.user_id=m.user_id and p.currency=m.currency
join public.financial_envelopes en on en.id=p.envelope_id and en.name=m.envelope_name
join public.financial_investments i on i.id=p.investment_id and i.name=m.investment_name
join public.financial_accounts a on a.id=p.account_id and a.name=m.account_name
on conflict (user_id,legacy_entry_id) do nothing;

insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
select 'v1_to_v2_approved_2026_09_17','valuation',id,user_id from public.financial_position_valuations where legacy_entry_id is not null
on conflict do nothing;
insert into public.financial_v2_migration_objects (migration_key,object_type,object_id,user_id)
select distinct 'v1_to_v2_approved_2026_09_17','position',p.id,p.user_id from public.financial_positions p
join public.financial_position_movements m on m.position_id=p.id
on conflict do nothing;

insert into public.financial_v2_migration_legacy_exclusions (migration_key,legacy_entry_id,classification,reason)
values ('v1_to_v2_approved_2026_09_17','102bd81b-d7c4-45e8-86a8-c56305cdf03e','aggregate_multi_envelope_valuation','Global SBS RTA PESOS / Brubank / ARS valuation; no approved allocation by envelope.')
on conflict do nothing;

do $$ declare p record; begin
  for p in select id from public.financial_positions for update loop
    perform public.financial_v2_rebuild_snapshot(p.id);
  end loop;
end $$;

-- Postchecks. Snapshot rebuild must run through the reviewed administrative routine after this script.
do $$
begin
  if (select count(*) from public.financial_position_movements where legacy_entry_id is not null) <> 22 then raise exception 'EXPECTED_22_CONTRIBUTIONS_NOT_MIGRATED'; end if;
  if (select count(*) from public.financial_position_valuations where legacy_entry_id is not null) <> 3 then raise exception 'EXPECTED_3_VALUATIONS_NOT_MIGRATED'; end if;
  if (select count(*) from public.financial_positions) <> 10 then raise exception 'EXPECTED_10_POSITIONS_NOT_MIGRATED'; end if;
  if (select count(*) from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='envelope') <> 5 then raise exception 'EXPECTED_5_ENVELOPES_NOT_TRACKED'; end if;
  if (select count(*) from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='investment') <> 6 then raise exception 'EXPECTED_6_INVESTMENTS_NOT_TRACKED'; end if;
  if (select count(*) from public.financial_v2_migration_objects where migration_key='v1_to_v2_approved_2026_09_17' and object_type='account') <> 2 then raise exception 'EXPECTED_2_ACCOUNTS_NOT_TRACKED'; end if;
  if exists (select 1 from public.financial_position_valuations where legacy_entry_id='102bd81b-d7c4-45e8-86a8-c56305cdf03e') then raise exception 'AGGREGATE_VALUATION_WAS_APPLIED'; end if;
  if (select coalesce(sum(m.amount),0) from public.financial_position_movements m join public.financial_positions p on p.id=m.position_id where m.kind='contribution' and p.currency='ARS') <> 1781702.93 then raise exception 'MIGRATED_ARS_TOTAL_CHANGED'; end if;
  if (select coalesce(sum(m.amount),0) from public.financial_position_movements m join public.financial_positions p on p.id=m.position_id where m.kind='contribution' and p.currency='USD') <> 330.78 then raise exception 'MIGRATED_USD_TOTAL_CHANGED'; end if;
end $$;

commit;
