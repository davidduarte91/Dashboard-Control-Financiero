-- TEST PROJECT ONLY. Review and run manually against the Supabase Test project.
-- Source: migration-preview-data.json. No Auth row, password, token or key is included.
-- Known export limits: exchange_rate was not exported (production default 1 is used);
-- financial_lists array ordering and updated_at were not exported.

begin;

create table if not exists public.financial_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  envelope text not null default '', investment text not null default '', account text not null default '',
  currency text not null check (currency in ('ARS','USD','USDT')),
  exchange_rate numeric not null default 1,
  amount numeric not null default 0, current_value numeric not null default 0,
  entry_date date not null,
  kind text not null default 'aporte' check (kind in ('aporte','retiro','valuacion')),
  created_at timestamptz not null default now()
);
create table if not exists public.financial_lists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelopes text[] not null default '{}', investments text[] not null default '{}', accounts text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- The Test Auth user must already exist. All 26 legacy UUIDs and exported values are preserved.
insert into public.financial_entries (id,user_id,envelope,investment,account,currency,amount,current_value,entry_date,kind,created_at) values
('f32e94e2-ab61-4175-ba8f-be7beab97e5e','c97a33f9-a691-442d-8140-d29c1a5a20ba','Mantenimiento auto','SBS RTA PESOS','Brubank','ARS',18000,18000,'2026-09-14','aporte','2026-09-14T23:19:47.127+00:00'),
('d071c320-98ff-4dce-a194-394116648c17','c97a33f9-a691-442d-8140-d29c1a5a20ba','Tarjeta credito Octubre ','SBS RTA PESOS','Brubank','ARS',129880.13,129880.13,'2026-09-14','aporte','2026-09-14T22:36:45.032+00:00'),
('40d5720c-3a31-499b-966f-ca12881f283d','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',37.1,37.1,'2026-09-14','aporte','2026-09-14T02:43:04.188+00:00'),
('35019c41-7be5-4b1c-a94b-2fffa1ba3d7a','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',37.1,37.1,'2026-09-14','aporte','2026-09-14T02:41:37.374+00:00'),
('1af794d4-90c1-457e-a8a6-1172f97164e2','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',21.64,21.64,'2026-09-12','aporte','2026-09-12T10:59:34.03+00:00'),
('b2fcca38-9d98-42fc-90e4-8924d7a33863','c97a33f9-a691-442d-8140-d29c1a5a20ba','Tarjeta credito Septiembre','SBS RTA PESOS','Brubank','ARS',200000,200000,'2026-09-11','aporte','2026-09-11T23:03:51.334829+00:00'),
('d86b3a8a-4042-4962-ad39-0c894c08263c','c97a33f9-a691-442d-8140-d29c1a5a20ba','','Cedears','Brubank','ARS',0,887870,'2026-09-10','valuacion','2026-09-10T23:55:54.578283+00:00'),
('577a29e7-52f2-4f59-a260-df73f19ed793','c97a33f9-a691-442d-8140-d29c1a5a20ba','','SBS RTA FIJA','Brubank','ARS',0,26151.54,'2026-09-10','valuacion','2026-09-10T23:55:06.922112+00:00'),
('102bd81b-d7c4-45e8-86a8-c56305cdf03e','c97a33f9-a691-442d-8140-d29c1a5a20ba','','SBS RTA PESOS','Brubank','ARS',0,625833.41,'2026-09-10','valuacion','2026-09-10T23:54:42.027759+00:00'),
('0233822a-83ac-4048-aa7b-92f290ae8688','c97a33f9-a691-442d-8140-d29c1a5a20ba','','Acciones argentinas','Brubank','ARS',0,113117,'2026-09-10','valuacion','2026-09-10T23:53:14.930564+00:00'),
('27a7f15f-e765-4c00-b426-45579ff13ae2','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones argentinas','Brubank','ARS',109181,109181,'2026-09-10','aporte','2026-09-10T23:38:38.367453+00:00'),
('39ab1b25-e6ea-43a4-a260-215bd53f9a46','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Cedears','Brubank','ARS',773186,773186,'2026-09-10','aporte','2026-09-10T23:38:01.652831+00:00'),
('2eaebe74-050d-4481-9e82-5da15ac0ec85','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','SBS RTA FIJA','Brubank','ARS',21000,21000,'2026-09-10','aporte','2026-09-10T23:36:56.706757+00:00'),
('5ae58f69-f664-4c1b-a908-e265950c5010','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Cedears','Brubank','ARS',40919.87,40919.87,'2026-09-14','aporte','2026-09-14T23:20:28.554+00:00'),
('e6f700ad-1fc0-4ee1-a320-a8cc768f16e7','c97a33f9-a691-442d-8140-d29c1a5a20ba','Vacaciones','SBS RTA PESOS','Brubank','ARS',19400,19400,'2026-09-14','aporte','2026-09-14T23:19:07.588+00:00'),
('b207d872-dea4-4b9d-a05d-aa2dec9d88cf','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Criptomonedas','Lemon','USD',15.23,15.23,'2026-09-14','aporte','2026-09-14T02:50:53.926+00:00'),
('b6d9c260-4a80-45e6-8f7f-4b1d0fe55767','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Criptomonedas','Lemon','USD',52.75,52.75,'2026-09-14','aporte','2026-09-14T02:48:15.736+00:00'),
('c6adb77c-d8b4-4f67-aaae-e6260168e942','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',55.66,55.66,'2026-09-14','aporte','2026-09-14T02:46:08.442+00:00'),
('91e0715a-4b3a-404f-bf02-f68685a4ac25','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',37.1,37.1,'2026-09-14','aporte','2026-09-14T02:45:19.398+00:00'),
('2dee9614-b615-4d62-a686-11a5c816368c','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',37.1,37.1,'2026-09-14','aporte','2026-09-14T02:44:47.774+00:00'),
('fea2b572-9b08-4950-b31c-b94a1961c26a','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','Acciones lemon','Lemon','USD',37.1,37.1,'2026-09-14','aporte','2026-09-14T02:43:48.002+00:00'),
('b5d17173-6585-4a9a-932e-8f4cc57d990c','c97a33f9-a691-442d-8140-d29c1a5a20ba','Ahorro David','SBS RTA PESOS','Brubank','ARS',246066.1,246066.1,'2026-09-10','aporte','2026-09-10T23:35:47.642226+00:00'),
('a634b4c8-3851-4970-92ac-56fa451b8b12','c97a33f9-a691-442d-8140-d29c1a5a20ba','Mantenimiento auto','SBS RTA PESOS','Brubank','ARS',345,345,'2026-09-10','aporte','2026-09-10T22:44:50.509684+00:00'),
('13ee34a6-86b7-4a9f-8f8d-fb2210929036','c97a33f9-a691-442d-8140-d29c1a5a20ba','Vacaciones','SBS RTA PESOS','Brubank','ARS',226.47,226.47,'2026-09-10','aporte','2026-09-10T22:43:32.148914+00:00'),
('e8b3cf41-ebe2-4bc7-b350-08738842be73','c97a33f9-a691-442d-8140-d29c1a5a20ba','Tarjeta credito Septiembre','SBS RTA PESOS','Brubank','ARS',99898.36,99898.36,'2026-09-10','aporte','2026-09-10T22:41:48.291187+00:00'),
('3f5ee313-a83c-48d8-8510-95593daf2510','c97a33f9-a691-442d-8140-d29c1a5a20ba','Tarjeta credito Septiembre','SBS RTA PESOS','Brubank','ARS',123600,123600,'2026-09-10','aporte','2026-09-10T22:20:49.193033+00:00')
on conflict (id) do nothing;

-- Membership is reconstructible from list_audit (used members plus its sole unused member FCI).
-- Original array order and updated_at are unavailable; updated_at uses the table default.
insert into public.financial_lists (user_id,envelopes,investments,accounts) values
('c97a33f9-a691-442d-8140-d29c1a5a20ba',array['Ahorro David','Mantenimiento auto','Tarjeta credito Octubre','Tarjeta credito Septiembre','Vacaciones'],array['Acciones argentinas','Acciones lemon','Cedears','Criptomonedas','FCI','SBS RTA FIJA','SBS RTA PESOS'],array['Brubank','Lemon'])
on conflict (user_id) do nothing;

do $$ begin
  if (select count(*) from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba') <> 26 then raise exception 'EXPECTED_26_ENTRIES'; end if;
  if (select count(*) from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='aporte') <> 22 then raise exception 'EXPECTED_22_CONTRIBUTIONS'; end if;
  if (select count(*) from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='valuacion') <> 4 then raise exception 'EXPECTED_4_VALUATIONS'; end if;
  if (select coalesce(sum(amount),0) from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='aporte' and currency='ARS') <> 1781702.93 then raise exception 'ARS_TOTAL_MISMATCH'; end if;
  if (select coalesce(sum(amount),0) from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='aporte' and currency='USD') <> 330.78 then raise exception 'USD_TOTAL_MISMATCH'; end if;
  if exists (select 1 from public.financial_entries where user_id<>'c97a33f9-a691-442d-8140-d29c1a5a20ba' and id in (select id from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba')) then raise exception 'USER_ID_MISMATCH'; end if;
end $$;

select kind,count(*) entries from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' group by kind order by kind;
select currency,sum(amount) contributions from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='aporte' group by currency order by currency;
select currency,count(*) withdrawals,sum(amount) withdrawals_total from public.financial_entries where user_id='c97a33f9-a691-442d-8140-d29c1a5a20ba' and kind='retiro' group by currency;

commit;
