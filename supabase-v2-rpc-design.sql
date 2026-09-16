-- Financial model v2 write RPCs: DESIGN ONLY. Do not execute yet.
-- Preconditions: deploy supabase-v2-schema.sql after review. The schema contains
-- immutable event tables, deterministic ordering, snapshots and idempotency storage.

-- Why these schema elements are required:
-- * An immutable correction needs a link to the original event and a database-level
--   guarantee that it cannot be reversed twice.
-- * UUID order is not a business ordering. event_sequence makes two valuations at
--   one timestamp deterministic, while movement-before-valuation remains explicit.
-- * The snapshot table is a rebuildable cache, never the financial source of truth.

begin;

-- Locks the sole position row. Every mutating RPC calls this first, so two devices
-- operating on the same position serialize at READ COMMITTED until transaction end.
create or replace function public.financial_v2_lock_owned_position(p_position_id uuid)
returns public.financial_positions
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions;
begin
  select * into v_position from public.financial_positions
  where id = p_position_id and user_id = auth.uid()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'POSITION_NOT_FOUND_OR_FORBIDDEN';
  end if;
  return v_position;
end;
$$;

-- Must run after the position is locked. A retry with the same request_id and exact
-- operation payload returns the stored response; a reused ID with different data fails.
create or replace function public.financial_v2_begin_write_request(
  p_position_id uuid, p_request_id uuid, p_operation text, p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_response jsonb; v_operation text; v_position_id uuid; v_fingerprint text; v_inserted integer;
begin
  if p_request_id is null then raise exception using errcode = '22023', message = 'REQUEST_ID_REQUIRED'; end if;
  v_fingerprint := p_payload::text;
  insert into public.financial_position_write_requests
    (user_id, request_id, position_id, operation, request_fingerprint)
  values (auth.uid(), p_request_id, p_position_id, p_operation, v_fingerprint)
  on conflict (user_id, request_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then return null; end if;
  select response, operation, position_id, request_fingerprint
    into v_response, v_operation, v_position_id, v_fingerprint
  from public.financial_position_write_requests
  where user_id = auth.uid() and request_id = p_request_id;
  if v_operation <> p_operation or v_position_id <> p_position_id or v_fingerprint <> p_payload::text then
    raise exception using errcode = 'P0001', message = 'REQUEST_ID_REUSED_WITH_DIFFERENT_OPERATION';
  end if;
  if v_response is null then raise exception using errcode = 'P0001', message = 'REQUEST_IN_PROGRESS'; end if;
  return v_response;
end;
$$;

create or replace function public.financial_v2_complete_write_request(p_request_id uuid, p_response jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.financial_position_write_requests
    set response = p_response, completed_at = now()
  where user_id = auth.uid() and request_id = p_request_id and response is null;
  if not found then raise exception using errcode = 'P0001', message = 'REQUEST_COMPLETION_FAILED'; end if;
end;
$$;

-- Replays immutable events in chronological order and atomically replaces the cache.
-- Same instant: movement first; event_sequence then orders events of the same type.
-- A retroactive valuation is rejected if it makes any already-recorded withdrawal
-- exceed the value available immediately before that withdrawal.
create or replace function public.financial_v2_rebuild_snapshot(p_position_id uuid)
returns public.financial_position_snapshots
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record;
  s public.financial_position_snapshots;
  v_gain numeric(20,2); v_from_gain numeric(20,2); v_from_capital numeric(20,2);
  v_loss_ratio numeric; v_realized_loss numeric(20,2); v_basis_reduction numeric(20,2);
begin
  -- Caller must already hold financial_positions(id) FOR UPDATE.
  select * into s from public.financial_position_snapshots where position_id = p_position_id for update;
  if not found then
    insert into public.financial_position_snapshots (
      position_id, user_id, current_value, historical_contributions, historical_withdrawals,
      capital_withdrawn, remaining_capital, capital_adjustments, value_adjustments, realized_gain, realized_loss,
      realized_performance, unrealized_performance, historical_performance
    ) select id, user_id, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      from public.financial_positions where id = p_position_id
      returning * into s;
  end if;
  s.current_value := 0; s.historical_contributions := 0; s.historical_withdrawals := 0;
  s.capital_withdrawn := 0; s.remaining_capital := 0; s.capital_adjustments := 0; s.value_adjustments := 0;
  s.realized_gain := 0; s.realized_loss := 0;
  s.last_valuation_at := null;

  for e in
    select event_type, event_at, event_sequence, id, kind, amount, valuation_value, adjustment_type
    from (
      select 1 as event_type, occurred_at as event_at, event_sequence, id, kind, amount, null::numeric as valuation_value, null::text as adjustment_type
      from public.financial_position_movements where position_id = p_position_id
      union all
      select 2, valued_at, event_sequence, id, null::text, null::numeric, value, null::text
      from public.financial_position_valuations where position_id = p_position_id
      union all
      select 3, occurred_at, event_sequence, id, null::text, amount, null::numeric, adjustment_type
      from public.financial_position_adjustments where position_id = p_position_id
    ) events
    order by event_at, event_type, event_sequence
  loop
    if e.event_type = 3 then
      if e.adjustment_type = 'capital_basis' then
        if s.remaining_capital + e.amount < 0 then
          raise exception using errcode = 'P0001', message = 'ADJUSTMENT_MAKES_CAPITAL_NEGATIVE', detail = e.id::text;
        end if;
        s.remaining_capital := round(s.remaining_capital + e.amount, 2);
        s.capital_adjustments := round(s.capital_adjustments + e.amount, 2);
      else
        if s.current_value + e.amount < 0 then
          raise exception using errcode = 'P0001', message = 'ADJUSTMENT_MAKES_VALUE_NEGATIVE', detail = e.id::text;
        end if;
        s.current_value := round(s.current_value + e.amount, 2);
        s.value_adjustments := round(s.value_adjustments + e.amount, 2);
      end if;
    elsif e.event_type = 2 then
      s.current_value := round(e.valuation_value, 2);
      s.last_valuation_at := e.event_at;
    elsif e.kind = 'contribution' then
      s.historical_contributions := round(s.historical_contributions + e.amount, 2);
      s.remaining_capital := round(s.remaining_capital + e.amount, 2);
      s.current_value := round(s.current_value + e.amount, 2);
    else
      if e.amount > s.current_value then
        raise exception using errcode = 'P0001',
          message = 'HISTORICAL_WITHDRAWAL_EXCEEDS_AVAILABLE_VALUE', detail = e.id::text;
      end if;
      v_gain := greatest(0, s.current_value - s.remaining_capital);
      v_from_gain := round(least(e.amount, v_gain), 2);
      v_from_capital := round(e.amount - v_from_gain, 2);
      v_loss_ratio := case when s.current_value > 0 and s.remaining_capital > s.current_value
        then (s.remaining_capital - s.current_value) / s.current_value else 0 end;
      v_realized_loss := round(-v_from_capital * v_loss_ratio, 2);
      v_basis_reduction := round(v_from_capital - v_realized_loss, 2);
      s.historical_withdrawals := round(s.historical_withdrawals + e.amount, 2);
      s.capital_withdrawn := round(s.capital_withdrawn + v_from_capital, 2);
      s.remaining_capital := round(greatest(0, s.remaining_capital - v_basis_reduction), 2);
      s.realized_gain := round(s.realized_gain + v_from_gain, 2);
      s.realized_loss := round(s.realized_loss + v_realized_loss, 2);
      s.current_value := round(s.current_value - e.amount, 2);
    end if;
  end loop;
  s.realized_performance := round(s.realized_gain + s.realized_loss, 2);
  s.unrealized_performance := round(s.current_value - s.remaining_capital, 2);
  s.historical_performance := round(s.realized_performance + s.unrealized_performance, 2);
  s.revision := s.revision + 1; s.computed_at := now();
  update public.financial_position_snapshots set
    revision = s.revision, current_value = s.current_value,
    historical_contributions = s.historical_contributions, historical_withdrawals = s.historical_withdrawals,
    capital_withdrawn = s.capital_withdrawn, remaining_capital = s.remaining_capital,
    capital_adjustments = s.capital_adjustments, value_adjustments = s.value_adjustments,
    realized_gain = s.realized_gain, realized_loss = s.realized_loss,
    realized_performance = s.realized_performance, unrealized_performance = s.unrealized_performance,
    historical_performance = s.historical_performance, last_valuation_at = s.last_valuation_at,
    computed_at = s.computed_at where position_id = p_position_id returning * into s;
  return s;
end;
$$;

-- All public write RPCs return the newly appended immutable record plus the rebuilt cache.
-- p_request_id is reserved for retry idempotency, but does not provide it by itself.
-- A request table is intentionally deferred: see decisions at the end of this file.
create or replace function public.financial_v2_record_contribution(
  p_position_id uuid, p_amount numeric(20,2), p_occurred_at timestamptz, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_movement public.financial_position_movements; v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
begin
  if p_amount <= 0 or p_occurred_at is null then raise exception using errcode = '22023', message = 'INVALID_CONTRIBUTION_INPUT'; end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'contribution', jsonb_build_object('amount', p_amount, 'occurred_at', p_occurred_at));
  if v_existing is not null then return v_existing; end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_movements (user_id, position_id, kind, amount, occurred_at, event_sequence)
  values (v_position.user_id, p_position_id, 'contribution', p_amount, p_occurred_at, v_sequence) returning * into v_movement;
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('movement', to_jsonb(v_movement), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

create or replace function public.financial_v2_record_withdrawal(
  p_position_id uuid, p_amount numeric(20,2), p_occurred_at timestamptz, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_movement public.financial_position_movements; v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
begin
  if p_amount <= 0 or p_occurred_at is null then raise exception using errcode = '22023', message = 'INVALID_WITHDRAWAL_INPUT'; end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'withdrawal', jsonb_build_object('amount', p_amount, 'occurred_at', p_occurred_at));
  if v_existing is not null then return v_existing; end if;
  -- Rebuild before insert so available value is based on the locked, latest ledger.
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  if p_amount > v_snapshot.current_value then
    raise exception using errcode = 'P0001', message = 'WITHDRAWAL_EXCEEDS_AVAILABLE_VALUE',
      detail = jsonb_build_object('available', v_snapshot.current_value, 'requested', p_amount)::text;
  end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_movements (user_id, position_id, kind, amount, occurred_at, event_sequence)
  values (v_position.user_id, p_position_id, 'withdrawal', p_amount, p_occurred_at, v_sequence) returning * into v_movement;
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('movement', to_jsonb(v_movement), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

create or replace function public.financial_v2_record_valuation(
  p_position_id uuid, p_value numeric(20,2), p_valued_at timestamptz, p_source text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_valuation public.financial_position_valuations; v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
begin
  if p_value < 0 or p_valued_at is null or p_source not in ('manual', 'imported', 'market') then
    raise exception using errcode = '22023', message = 'INVALID_VALUATION_INPUT';
  end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'valuation', jsonb_build_object('value', p_value, 'valued_at', p_valued_at, 'source', p_source));
  if v_existing is not null then return v_existing; end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_valuations (user_id, position_id, value, valued_at, source, event_sequence)
  values (v_position.user_id, p_position_id, p_value, p_valued_at, p_source, v_sequence) returning * into v_valuation;
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('valuation', to_jsonb(v_valuation), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

-- A movement reversal appends the opposite kind and preserves the original reference.
-- The common withdrawal validation still applies after replay; an invalid historical
-- correction fails atomically rather than creating a negative position.
create or replace function public.financial_v2_reverse_movement(
  p_position_id uuid, p_original_movement_id uuid, p_occurred_at timestamptz, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_original public.financial_position_movements; v_reversal public.financial_position_movements; v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
begin
  if p_occurred_at is null then raise exception using errcode = '22023', message = 'INVALID_REVERSAL_TIMESTAMP'; end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'reverse_movement', jsonb_build_object('original_movement_id', p_original_movement_id, 'occurred_at', p_occurred_at));
  if v_existing is not null then return v_existing; end if;
  select * into v_original from public.financial_position_movements
  where id = p_original_movement_id and position_id = p_position_id and user_id = v_position.user_id;
  if not found then raise exception using errcode = 'P0001', message = 'MOVEMENT_NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists (select 1 from public.financial_position_movements where reversal_of_movement_id = p_original_movement_id) then
    raise exception using errcode = 'P0001', message = 'MOVEMENT_ALREADY_REVERSED';
  end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_movements (user_id, position_id, kind, amount, occurred_at, event_sequence, reversal_of_movement_id)
  values (v_position.user_id, p_position_id,
    case v_original.kind when 'contribution' then 'withdrawal' else 'contribution' end,
    v_original.amount, p_occurred_at, v_sequence, v_original.id) returning * into v_reversal;
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('movement', to_jsonb(v_reversal), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

-- A valuation correction appends a replacement valuation and links to the erroneous
-- record. Its event_sequence makes it win over another valuation at the same instant.
create or replace function public.financial_v2_correct_valuation(
  p_position_id uuid, p_original_valuation_id uuid, p_replacement_value numeric(20,2),
  p_valued_at timestamptz, p_source text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_original public.financial_position_valuations; v_correction public.financial_position_valuations; v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
begin
  if p_replacement_value < 0 or p_valued_at is null or p_source not in ('manual', 'imported', 'market') then raise exception using errcode = '22023', message = 'INVALID_VALUATION_CORRECTION_INPUT'; end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'correct_valuation', jsonb_build_object('original_valuation_id', p_original_valuation_id, 'replacement_value', p_replacement_value, 'valued_at', p_valued_at, 'source', p_source));
  if v_existing is not null then return v_existing; end if;
  select * into v_original from public.financial_position_valuations
  where id = p_original_valuation_id and position_id = p_position_id and user_id = v_position.user_id;
  if not found then raise exception using errcode = 'P0001', message = 'VALUATION_NOT_FOUND_OR_FORBIDDEN'; end if;
  if exists (select 1 from public.financial_position_valuations where reversal_of_valuation_id = p_original_valuation_id) then raise exception using errcode = 'P0001', message = 'VALUATION_ALREADY_CORRECTED'; end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_valuations (user_id, position_id, value, valued_at, source, event_sequence, reversal_of_valuation_id)
  values (v_position.user_id, p_position_id, p_replacement_value, p_valued_at, p_source, v_sequence, v_original.id) returning * into v_correction;
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('valuation', to_jsonb(v_correction), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

-- Exceptional correction, not a substitute for edits or ordinary reversals.
-- capital_basis changes remaining capital only; value changes current value only.
-- Direct realized-performance adjustments are intentionally unsupported because they
-- would manufacture return without a corresponding financial event.
create or replace function public.financial_v2_record_adjustment(
  p_position_id uuid, p_adjustment_type text, p_amount numeric(20,2), p_occurred_at timestamptz,
  p_reason text, p_related_movement_ids uuid[], p_related_valuation_ids uuid[], p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position public.financial_positions; v_adjustment public.financial_position_adjustments;
  v_snapshot public.financial_position_snapshots; v_sequence bigint; v_existing jsonb; v_result jsonb;
  v_movement_count integer; v_valuation_count integer;
begin
  if p_adjustment_type not in ('capital_basis', 'value') or p_amount = 0 or p_occurred_at is null
    or p_reason is null or p_reason <> btrim(p_reason) or p_reason = '' then
    raise exception using errcode = '22023', message = 'INVALID_ADJUSTMENT_INPUT';
  end if;
  if coalesce(cardinality(p_related_movement_ids), 0) + coalesce(cardinality(p_related_valuation_ids), 0) = 0
    or array_position(p_related_movement_ids, null) is not null or array_position(p_related_valuation_ids, null) is not null then
    raise exception using errcode = '22023', message = 'ADJUSTMENT_REFERENCE_REQUIRED';
  end if;
  v_position := public.financial_v2_lock_owned_position(p_position_id);
  v_existing := public.financial_v2_begin_write_request(p_position_id, p_request_id, 'adjustment',
    jsonb_build_object('type', p_adjustment_type, 'amount', p_amount, 'occurred_at', p_occurred_at,
      'reason', p_reason, 'movement_ids', p_related_movement_ids, 'valuation_ids', p_related_valuation_ids));
  if v_existing is not null then return v_existing; end if;
  select count(*) into v_movement_count from public.financial_position_movements
    where id = any(p_related_movement_ids) and position_id = p_position_id and user_id = v_position.user_id;
  select count(*) into v_valuation_count from public.financial_position_valuations
    where id = any(p_related_valuation_ids) and position_id = p_position_id and user_id = v_position.user_id;
  if v_movement_count <> coalesce(cardinality(p_related_movement_ids), 0)
    or v_valuation_count <> coalesce(cardinality(p_related_valuation_ids), 0) then
    raise exception using errcode = 'P0001', message = 'ADJUSTMENT_REFERENCE_NOT_FOUND_OR_FORBIDDEN';
  end if;
  select coalesce(max(event_sequence), 0) + 1 into v_sequence from (
    select event_sequence from public.financial_position_movements where position_id = p_position_id
    union all select event_sequence from public.financial_position_valuations where position_id = p_position_id
    union all select event_sequence from public.financial_position_adjustments where position_id = p_position_id
  ) event_sequences;
  insert into public.financial_position_adjustments
    (user_id, position_id, adjustment_type, amount, occurred_at, event_sequence, reason, created_by)
  values (v_position.user_id, p_position_id, p_adjustment_type, p_amount, p_occurred_at, v_sequence, p_reason, auth.uid())
  returning * into v_adjustment;
  insert into public.financial_position_adjustment_references (adjustment_id, user_id, movement_id)
    select v_adjustment.id, v_position.user_id, unnest(p_related_movement_ids);
  insert into public.financial_position_adjustment_references (adjustment_id, user_id, valuation_id)
    select v_adjustment.id, v_position.user_id, unnest(p_related_valuation_ids);
  v_snapshot := public.financial_v2_rebuild_snapshot(p_position_id);
  v_result := jsonb_build_object('adjustment', to_jsonb(v_adjustment), 'snapshot', to_jsonb(v_snapshot));
  perform public.financial_v2_complete_write_request(p_request_id, v_result);
  return v_result;
end;
$$;

-- Administrative reconciliation routine. It has no grant for client roles and must be
-- invoked only from controlled server administration after an explicit reconciliation plan.
create or replace function public.financial_v2_admin_rebuild_snapshots(p_user_id uuid default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_position record; v_count integer := 0;
begin
  if auth.uid() is not null then raise exception using errcode = '42501', message = 'ADMIN_CONTEXT_REQUIRED'; end if;
  for v_position in select id from public.financial_positions
    where p_user_id is null or user_id = p_user_id order by id for update
  loop
    perform public.financial_v2_rebuild_snapshot(v_position.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Explicitly expose only the six public writers. The lock and rebuild helpers stay internal.
revoke all on function public.financial_v2_lock_owned_position(uuid) from public;
revoke all on function public.financial_v2_begin_write_request(uuid, uuid, text, jsonb) from public;
revoke all on function public.financial_v2_complete_write_request(uuid, jsonb) from public;
revoke all on function public.financial_v2_rebuild_snapshot(uuid) from public;
revoke all on function public.financial_v2_admin_rebuild_snapshots(uuid) from public;
revoke all on function public.financial_v2_record_contribution(uuid, numeric, timestamptz, uuid) from public;
revoke all on function public.financial_v2_record_withdrawal(uuid, numeric, timestamptz, uuid) from public;
revoke all on function public.financial_v2_record_valuation(uuid, numeric, timestamptz, text, uuid) from public;
revoke all on function public.financial_v2_reverse_movement(uuid, uuid, timestamptz, uuid) from public;
revoke all on function public.financial_v2_correct_valuation(uuid, uuid, numeric, timestamptz, text, uuid) from public;
revoke all on function public.financial_v2_record_adjustment(uuid, text, numeric, timestamptz, text, uuid[], uuid[], uuid) from public;
grant execute on function public.financial_v2_record_contribution(uuid, numeric, timestamptz, uuid) to authenticated;
grant execute on function public.financial_v2_record_withdrawal(uuid, numeric, timestamptz, uuid) to authenticated;
grant execute on function public.financial_v2_record_valuation(uuid, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.financial_v2_reverse_movement(uuid, uuid, timestamptz, uuid) to authenticated;
grant execute on function public.financial_v2_correct_valuation(uuid, uuid, numeric, timestamptz, text, uuid) to authenticated;
grant execute on function public.financial_v2_record_adjustment(uuid, text, numeric, timestamptz, text, uuid[], uuid[], uuid) to authenticated;

commit;

-- Recommendation: hybrid snapshots.
-- The ledger is authoritative; the snapshot is a transactional cache. Read dashboards
-- use snapshots, while every write locks one position and fully replays its own ledger.
-- Full replay is simple and correct for a personal-finance dataset, and retroactive
-- valuations remain safe. If histories grow substantially, replay only from a verified
-- checkpoint, retaining an on-demand full rebuild for reconciliation.
--
-- Every public writer requires p_request_id. financial_position_write_requests stores
-- the operation fingerprint and exact response in the same transaction. A retry returns
-- that response without appending a second event.
