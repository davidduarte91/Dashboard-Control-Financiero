create table public.financial_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  envelope text not null default '',
  investment text not null default '',
  account text not null default '',
  currency text not null check (currency in ('ARS', 'USD', 'USDT')),
  amount numeric not null default 0,
  current_value numeric not null default 0,
  entry_date date not null,
  kind text not null default 'aporte' check (kind in ('aporte', 'retiro', 'valuacion')),
  created_at timestamptz not null default now()
);

create table public.financial_lists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelopes text[] not null default '{}',
  investments text[] not null default '{}',
  accounts text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.financial_entries enable row level security;
alter table public.financial_lists enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.financial_entries to authenticated;
grant select, insert, update, delete on table public.financial_lists to authenticated;

create policy "Users manage their own financial entries"
  on public.financial_entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users manage their own financial lists"
  on public.financial_lists for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
