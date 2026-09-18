import type { SupabaseClient } from "@supabase/supabase-js";

type Client = Pick<SupabaseClient, "rpc">;

export type ContributionRequest = {
  positionId: string;
  amount: number;
  occurredAt: string;
  requestId: string;
};

export type ContributionResult = {
  movement: { id: string; position_id: string; amount: number | string };
  snapshot: { position_id: string; current_value: number | string };
};

export type ContributionPositionLookup = {
  id: string;
  envelopeId: string;
  investmentId: string;
  accountId: string;
  currency: string;
  archivedAt?: string;
};

export function resolveExistingContributionPosition(
  positions: ContributionPositionLookup[],
  names: { envelopeName: Record<string, string>; investmentName: Record<string, string>; accountName: Record<string, string> },
  selection: { envelope: string; investment: string; account: string; currency: string },
) {
  return positions.find((position) => !position.archivedAt
    && names.envelopeName[position.envelopeId] === selection.envelope
    && names.investmentName[position.investmentId] === selection.investment
    && names.accountName[position.accountId] === selection.account
    && position.currency === selection.currency) || null;
}

export function canApplyContributionResult(
  requestSession: { userId: string | null },
  currentSession: { userId: string | null },
) {
  return requestSession === currentSession && Boolean(requestSession.userId);
}

function assertContribution(request: ContributionRequest) {
  if (!request.positionId || !request.requestId || !Number.isFinite(request.amount)
    || request.amount <= 0 || Math.round(request.amount * 100) !== request.amount * 100
    || Number.isNaN(Date.parse(request.occurredAt))) {
    throw new Error("El aporte v2 requiere una posición, un importe positivo de hasta dos decimales y una fecha válida.");
  }
}

export function createContributionRequest(
  positionId: string,
  amount: number,
  occurredAt = new Date().toISOString(),
  requestId = crypto.randomUUID(),
): ContributionRequest {
  const request = { positionId, amount, occurredAt, requestId };
  assertContribution(request);
  return request;
}

/** Calls the only permitted v2 write path. The server owns locking, replay and idempotency. */
export async function recordContribution(
  client: Client,
  request: ContributionRequest,
): Promise<ContributionResult> {
  assertContribution(request);
  const { data, error } = await client.rpc("financial_v2_record_contribution", {
    p_position_id: request.positionId,
    p_amount: request.amount,
    p_occurred_at: request.occurredAt,
    p_request_id: request.requestId,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== "object" || !("movement" in data) || !("snapshot" in data)) {
    throw new Error("La RPC de aporte v2 devolvió una respuesta incompleta.");
  }
  return data as ContributionResult;
}
