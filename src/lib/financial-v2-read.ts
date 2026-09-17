import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregateByEnvelope, aggregateByInvestment,
  type Account, type Envelope, type Investment, type Position, type PositionMovement,
  type PositionSnapshot, type PositionValuation,
} from "@/domain/financial-v2";

type Client = Pick<SupabaseClient, "from">;
const number = (value: unknown) => Number(value || 0);

export type FinancialV2Data = {
  envelopes: Envelope[]; investments: Investment[]; accounts: Account[]; positions: Position[];
  movements: PositionMovement[]; valuations: PositionValuation[]; snapshots: PositionSnapshot[];
};
export type V2Dashboard = FinancialV2Data & {
  complete: boolean;
  envelopeGroups: ReturnType<typeof aggregateByEnvelope>;
  investmentGroups: ReturnType<typeof aggregateByInvestment>;
  envelopeName: Record<string, string>; investmentName: Record<string, string>; accountName: Record<string, string>;
  hasPendingSbsReconciliation: boolean;
};

export async function readFinancialV2(client: Client, userId: string): Promise<FinancialV2Data> {
  const [envelopes, investments, accounts, positions, movements, valuations, snapshots] = await Promise.all([
    client.from("financial_envelopes").select("id,user_id,name,archived_at").eq("user_id", userId),
    client.from("financial_investments").select("id,user_id,name,archived_at").eq("user_id", userId),
    client.from("financial_accounts").select("id,user_id,name,archived_at").eq("user_id", userId),
    client.from("financial_positions").select("id,user_id,envelope_id,investment_id,account_id,currency,archived_at").eq("user_id", userId),
    client.from("financial_position_movements").select("id,position_id,kind,amount,occurred_at,created_at,transfer_id").eq("user_id", userId),
    client.from("financial_position_valuations").select("id,position_id,value,valued_at,created_at,source").eq("user_id", userId),
    client.from("financial_position_snapshots").select("position_id,current_value,historical_contributions,historical_withdrawals,capital_withdrawn,remaining_capital,realized_gain,realized_loss,realized_performance,unrealized_performance,historical_performance,last_valuation_at").eq("user_id", userId),
  ]);
  const results = [envelopes, investments, accounts, positions, movements, valuations, snapshots];
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  const mappedPositions = (positions.data || []).map((r) => ({
    id: r.id, userId: r.user_id, envelopeId: r.envelope_id, investmentId: r.investment_id,
    accountId: r.account_id, currency: r.currency, archivedAt: r.archived_at || undefined,
  })) as Position[];
  const currencyByPosition = new Map(mappedPositions.map((position) => [position.id, position.currency]));
  return {
    envelopes: (envelopes.data || []).map((r) => ({ id: r.id, userId: r.user_id, name: r.name, archivedAt: r.archived_at || undefined })),
    investments: (investments.data || []).map((r) => ({ id: r.id, userId: r.user_id, name: r.name, archivedAt: r.archived_at || undefined })),
    accounts: (accounts.data || []).map((r) => ({ id: r.id, userId: r.user_id, name: r.name, archivedAt: r.archived_at || undefined })),
    positions: mappedPositions,
    movements: (movements.data || []).map((r) => ({ id: r.id, positionId: r.position_id, kind: r.kind, amount: number(r.amount), occurredAt: r.occurred_at, createdAt: r.created_at, transferId: r.transfer_id || undefined })) as PositionMovement[],
    valuations: (valuations.data || []).map((r) => ({ id: r.id, positionId: r.position_id, value: number(r.value), valuedAt: r.valued_at, createdAt: r.created_at, source: r.source || undefined })) as PositionValuation[],
    snapshots: (snapshots.data || []).map((r) => ({ positionId: r.position_id, currency: currencyByPosition.get(r.position_id) || "ARS", currentValue: number(r.current_value), availableToWithdraw: number(r.current_value), historicalContributions: number(r.historical_contributions), historicalWithdrawals: number(r.historical_withdrawals), capitalWithdrawn: number(r.capital_withdrawn), remainingCapital: number(r.remaining_capital), realizedGain: number(r.realized_gain), realizedLoss: number(r.realized_loss), realizedPerformance: number(r.realized_performance), unrealizedPerformance: number(r.unrealized_performance), historicalPerformance: number(r.historical_performance), lastValuationAt: r.last_valuation_at || undefined, withdrawalBreakdowns: [] })),
  };
}

export function buildV2Dashboard(data: FinancialV2Data): V2Dashboard {
  const positionsById = new Map(data.positions.map((position) => [position.id, position]));
  const snapshots = data.snapshots.map((snapshot) => ({ ...snapshot, currency: positionsById.get(snapshot.positionId)?.currency || snapshot.currency }));
  const complete = data.positions.length === snapshots.length && snapshots.every((snapshot) => positionsById.has(snapshot.positionId));
  const names = <T extends { id: string; name: string }>(items: T[]) => Object.fromEntries(items.map((item) => [item.id, item.name]));
  return { ...data, snapshots, complete, envelopeGroups: aggregateByEnvelope(data.positions, snapshots), investmentGroups: aggregateByInvestment(data.positions, snapshots), envelopeName: names(data.envelopes), investmentName: names(data.investments), accountName: names(data.accounts), hasPendingSbsReconciliation: data.positions.some((position) => data.investments.find((investment) => investment.id === position.investmentId)?.name === "SBS RTA PESOS") };
}
