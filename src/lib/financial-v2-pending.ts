import type { ContributionRequest } from "./financial-v2-write";

export const PENDING_CONTRIBUTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingContribution = ContributionRequest & {
  userId: string;
  operation: "contribution";
  createdAt: string;
  status: "pending";
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function key(userId: string) {
  if (!userId) throw new Error("Un aporte pendiente requiere un usuario identificado.");
  return `finanzas-v2:pending-contributions:v1:${userId}`;
}

function isPendingContribution(value: unknown): value is PendingContribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.operation === "contribution" && item.status === "pending"
    && ["userId", "requestId", "positionId", "occurredAt", "createdAt"].every((name) => typeof item[name] === "string" && Boolean(item[name]))
    && typeof item.amount === "number" && Number.isFinite(item.amount) && item.amount > 0
    && Math.round(item.amount * 100) === item.amount * 100
    && !Number.isNaN(Date.parse(String(item.occurredAt)))
    && !Number.isNaN(Date.parse(String(item.createdAt)));
}

function active(items: PendingContribution[], now: number) {
  return items.filter((item) => {
    const age = now - Date.parse(item.createdAt);
    return age >= 0 && age <= PENDING_CONTRIBUTION_MAX_AGE_MS;
  });
}

export function readPendingContributions(storage: StorageLike, userId: string, now = Date.now()): PendingContribution[] {
  const raw = storage.getItem(key(userId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isPendingContribution)) return [];
    const own = parsed.filter((item) => item.userId === userId);
    const valid = active(own, now);
    if (valid.length !== parsed.length) {
      if (valid.length) storage.setItem(key(userId), JSON.stringify(valid));
      else storage.removeItem(key(userId));
    }
    return valid.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}

export function findPendingContribution(
  storage: StorageLike,
  userId: string,
  positionId: string,
  amount: number,
  now = Date.now(),
) {
  return readPendingContributions(storage, userId, now)
    .find((item) => item.positionId === positionId && item.amount === amount) || null;
}

export function savePendingContribution(storage: StorageLike, pending: PendingContribution, now = Date.now()) {
  if (!isPendingContribution(pending)) throw new Error("El aporte pendiente no es válido.");
  const current = readPendingContributions(storage, pending.userId, now);
  const next = [...current.filter((item) => item.requestId !== pending.requestId), pending];
  storage.setItem(key(pending.userId), JSON.stringify(next));
  return pending;
}

export function removePendingContribution(storage: StorageLike, userId: string, requestId: string, now = Date.now()) {
  const next = readPendingContributions(storage, userId, now).filter((item) => item.requestId !== requestId);
  if (next.length) storage.setItem(key(userId), JSON.stringify(next));
  else storage.removeItem(key(userId));
  return next;
}

/** Unknown errors remain retryable because a network response may have been lost. */
export function isDefinitiveContributionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /INVALID_CONTRIBUTION_INPUT|IDEMPOTENCY_PAYLOAD_MISMATCH|POSITION_(NOT_FOUND|NOT_OWNED)|UNAUTHORIZED|permission denied|invalid input/i.test(message);
}
