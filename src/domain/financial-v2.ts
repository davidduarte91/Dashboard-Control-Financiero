export const MONEY_DECIMALS = 2;

export type Currency = "ARS" | "USD" | "USDT";
export type MovementKind = "contribution" | "withdrawal";

export type Envelope = {
  id: string;
  userId: string;
  name: string;
  archivedAt?: string;
};

export type Investment = {
  id: string;
  userId: string;
  name: string;
  archivedAt?: string;
};

export type Account = {
  id: string;
  userId: string;
  name: string;
  archivedAt?: string;
};

/** A position is the only place where money can be held. */
export type Position = {
  id: string;
  userId: string;
  envelopeId: string;
  investmentId: string;
  accountId: string;
  currency: Currency;
  archivedAt?: string;
};

/** Amounts are always positive; kind determines whether value enters or leaves. */
export type PositionMovement = {
  id: string;
  positionId: string;
  kind: MovementKind;
  amount: number;
  occurredAt: string;
  createdAt?: string;
  /** Reserved for the future transfer feature. */
  transferId?: string;
};

/** A manual or imported statement of a position's total value in its native currency. */
export type PositionValuation = {
  id: string;
  positionId: string;
  value: number;
  valuedAt: string;
  createdAt?: string;
  source?: "manual" | "imported" | "market";
};

export type WithdrawalBreakdown = {
  withdrawalId?: string;
  amount: number;
  fromGain: number;
  fromCapital: number;
  realizedLoss: number;
  capitalBasisReduction: number;
};

export type PositionPerformance = {
  historicalContributions: number;
  historicalWithdrawals: number;
  capitalWithdrawn: number;
  remainingCapital: number;
  realizedGain: number;
  realizedLoss: number;
  realizedPerformance: number;
  unrealizedPerformance: number;
  historicalPerformance: number;
};

export type PositionSnapshot = PositionPerformance & {
  positionId: string;
  currency: Currency;
  currentValue: number;
  availableToWithdraw: number;
  lastValuationAt?: string;
  withdrawalBreakdowns: WithdrawalBreakdown[];
};

export type ConversionContext = {
  baseCurrency: Currency;
  /** One unit of the listed currency expressed in baseCurrency. */
  ratesToBase: Partial<Record<Currency, number>>;
  asOf?: string;
};

export type CurrencyTotals = Partial<Record<Currency, PositionPerformance & { currentValue: number }>>;

export type GroupSnapshot = {
  groupId: string;
  native: CurrencyTotals;
  baseCurrency?: Currency;
  converted?: PositionPerformance & { currentValue: number };
};

export class FinancialDomainError extends Error {}

const round = (value: number) => Number((Math.round((value + Number.EPSILON) * 100) / 100).toFixed(MONEY_DECIMALS));

function assertMoney(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new FinancialDomainError(`${name} debe ser un número finito mayor o igual que cero.`);
  }
}

function eventTime(value: { occurredAt?: string; valuedAt?: string; createdAt?: string; id: string }) {
  return value.occurredAt || value.valuedAt || value.createdAt || value.id;
}

type ReplayEvent =
  | { type: "movement"; movement: PositionMovement }
  | { type: "valuation"; valuation: PositionValuation };

type ReplayState = {
  currentValue: number;
  historicalContributions: number;
  historicalWithdrawals: number;
  capitalWithdrawn: number;
  remainingCapital: number;
  realizedGain: number;
  realizedLoss: number;
  lastValuationAt?: string;
  withdrawalBreakdowns: WithdrawalBreakdown[];
};

function emptyState(): ReplayState {
  return {
    currentValue: 0,
    historicalContributions: 0,
    historicalWithdrawals: 0,
    capitalWithdrawn: 0,
    remainingCapital: 0,
    realizedGain: 0,
    realizedLoss: 0,
    withdrawalBreakdowns: [],
  };
}

/**
 * Splits a withdrawal against the value known immediately before it.
 * In a gain, gain is consumed first. In a loss, cash comes from capital and
 * the proportional loss becomes realized so total performance is conserved.
 */
export function describeWithdrawal(
  amount: number,
  currentValue: number,
  remainingCapital: number,
  withdrawalId?: string,
): WithdrawalBreakdown {
  assertMoney(amount, "El retiro");
  assertMoney(currentValue, "El valor actual");
  assertMoney(remainingCapital, "El capital pendiente");
  if (amount > currentValue) {
    throw new FinancialDomainError("El retiro no puede superar el valor actual disponible de la posición.");
  }
  const gainAvailable = Math.max(0, currentValue - remainingCapital);
  const fromGain = round(Math.min(amount, gainAvailable));
  const fromCapital = round(amount - fromGain);
  const lossRatio = currentValue > 0 && remainingCapital > currentValue
    ? (remainingCapital - currentValue) / currentValue
    : 0;
  const realizedLoss = round(-fromCapital * lossRatio);
  const capitalBasisReduction = round(fromCapital - realizedLoss);
  return { withdrawalId, amount: round(amount), fromGain, fromCapital, realizedLoss, capitalBasisReduction };
}

export function validateWithdrawal(snapshot: Pick<PositionSnapshot, "currentValue" | "remainingCapital">, amount: number) {
  return describeWithdrawal(amount, snapshot.currentValue, snapshot.remainingCapital);
}

export function calculatePositionSnapshot(
  position: Position,
  movements: PositionMovement[],
  valuations: PositionValuation[],
): PositionSnapshot {
  const events: ReplayEvent[] = [
    ...movements.filter((movement) => movement.positionId === position.id).map((movement) => ({ type: "movement" as const, movement })),
    ...valuations.filter((valuation) => valuation.positionId === position.id).map((valuation) => ({ type: "valuation" as const, valuation })),
  ].sort((left, right) => {
    const leftValue = left.type === "movement" ? left.movement : left.valuation;
    const rightValue = right.type === "movement" ? right.movement : right.valuation;
    const time = eventTime(leftValue).localeCompare(eventTime(rightValue));
    if (time) return time;
    // A valuation states the value after any movement at the same instant.
    if (left.type !== right.type) return left.type === "movement" ? -1 : 1;
    return leftValue.id.localeCompare(rightValue.id);
  });
  const state = emptyState();
  for (const event of events) {
    if (event.type === "valuation") {
      assertMoney(event.valuation.value, "La valuación");
      state.currentValue = round(event.valuation.value);
      state.lastValuationAt = event.valuation.valuedAt;
      continue;
    }
    const movement = event.movement;
    assertMoney(movement.amount, movement.kind === "contribution" ? "El aporte" : "El retiro");
    if (movement.kind === "contribution") {
      state.historicalContributions = round(state.historicalContributions + movement.amount);
      state.remainingCapital = round(state.remainingCapital + movement.amount);
      state.currentValue = round(state.currentValue + movement.amount);
      continue;
    }
    const withdrawal = describeWithdrawal(movement.amount, state.currentValue, state.remainingCapital, movement.id);
    state.historicalWithdrawals = round(state.historicalWithdrawals + withdrawal.amount);
    state.capitalWithdrawn = round(state.capitalWithdrawn + withdrawal.fromCapital);
    state.remainingCapital = round(Math.max(0, state.remainingCapital - withdrawal.capitalBasisReduction));
    state.realizedGain = round(state.realizedGain + withdrawal.fromGain);
    state.realizedLoss = round(state.realizedLoss + withdrawal.realizedLoss);
    state.currentValue = round(state.currentValue - withdrawal.amount);
    state.withdrawalBreakdowns.push(withdrawal);
  }
  const unrealizedPerformance = round(state.currentValue - state.remainingCapital);
  const realizedPerformance = round(state.realizedGain + state.realizedLoss);
  const historicalPerformance = round(realizedPerformance + unrealizedPerformance);
  return {
    positionId: position.id,
    currency: position.currency,
    currentValue: state.currentValue,
    availableToWithdraw: state.currentValue,
    historicalContributions: state.historicalContributions,
    historicalWithdrawals: state.historicalWithdrawals,
    capitalWithdrawn: state.capitalWithdrawn,
    remainingCapital: state.remainingCapital,
    realizedGain: state.realizedGain,
    realizedLoss: state.realizedLoss,
    realizedPerformance,
    unrealizedPerformance,
    historicalPerformance,
    lastValuationAt: state.lastValuationAt,
    withdrawalBreakdowns: state.withdrawalBreakdowns,
  };
}

export function convertToBase(value: number, currency: Currency, conversion: ConversionContext) {
  assertMoney(Math.abs(value), "El importe");
  if (currency === conversion.baseCurrency) return round(value);
  const rate = conversion.ratesToBase[currency];
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw new FinancialDomainError(`Falta una cotización explícita de ${currency} a ${conversion.baseCurrency}.`);
  }
  return round(value * rate);
}

function emptyPerformance() {
  return {
    currentValue: 0,
    historicalContributions: 0,
    historicalWithdrawals: 0,
    capitalWithdrawn: 0,
    remainingCapital: 0,
    realizedGain: 0,
    realizedLoss: 0,
    realizedPerformance: 0,
    unrealizedPerformance: 0,
    historicalPerformance: 0,
  };
}

function addSnapshot(target: ReturnType<typeof emptyPerformance>, snapshot: PositionSnapshot, multiplier = 1) {
  for (const key of Object.keys(target) as (keyof typeof target)[]) {
    target[key] = round(target[key] + snapshot[key] * multiplier);
  }
  return target;
}

function aggregate(
  positions: Position[],
  snapshots: PositionSnapshot[],
  groupForPosition: (position: Position) => string,
  conversion?: ConversionContext,
): GroupSnapshot[] {
  const positionsById = new Map(positions.map((position) => [position.id, position]));
  const groups = new Map<string, GroupSnapshot>();
  for (const snapshot of snapshots) {
    const position = positionsById.get(snapshot.positionId);
    if (!position) throw new FinancialDomainError(`No existe la posición ${snapshot.positionId} para agregar sus valores.`);
    if (position.currency !== snapshot.currency) throw new FinancialDomainError("La moneda de la posición no coincide con su resumen.");
    const groupId = groupForPosition(position);
    const group = groups.get(groupId) || { groupId, native: {} };
    const native = group.native[snapshot.currency] || emptyPerformance();
    group.native[snapshot.currency] = addSnapshot(native, snapshot);
    if (conversion) {
      group.baseCurrency = conversion.baseCurrency;
      const converted = group.converted || emptyPerformance();
      const convertedSnapshot = Object.fromEntries(
        Object.entries(emptyPerformance()).map(([key]) => [key, convertToBase(snapshot[key as keyof typeof snapshot] as number, snapshot.currency, conversion)]),
      ) as ReturnType<typeof emptyPerformance>;
      group.converted = addSnapshot(converted, convertedSnapshot as PositionSnapshot);
    }
    groups.set(groupId, group);
  }
  return [...groups.values()].sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export function aggregateByEnvelope(positions: Position[], snapshots: PositionSnapshot[], conversion?: ConversionContext) {
  return aggregate(positions, snapshots, (position) => position.envelopeId, conversion);
}

export function aggregateByInvestment(positions: Position[], snapshots: PositionSnapshot[], conversion?: ConversionContext) {
  return aggregate(positions, snapshots, (position) => position.investmentId, conversion);
}

export function aggregateByAccount(positions: Position[], snapshots: PositionSnapshot[], conversion?: ConversionContext) {
  return aggregate(positions, snapshots, (position) => position.accountId, conversion);
}
