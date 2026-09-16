import type { Entry, FinancialLists } from "./financial-sync";

export type FinancialSnapshot = { entries: Entry[]; lists: FinancialLists };
export type FinancialSession = { userId: string | null; ready: boolean };

function cacheKey(userId: string) {
  if (!userId) throw new Error("La copia local requiere un usuario identificado.");
  return `finanzas-cache:v1:${userId}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function isEntry(value: unknown): value is Entry {
  return isRecord(value)
    && ["id", "envelope", "investment", "account", "date"].every((key) => typeof value[key] === "string")
    && ["ARS", "USD", "USDT"].includes(String(value.currency))
    && isNumber(value.amount) && isNumber(value.currentValue)
    && (value.exchangeRate === undefined || isNumber(value.exchangeRate))
    && (value.createdAt === undefined || typeof value.createdAt === "string")
    && (value.kind === undefined || ["aporte", "retiro", "valuacion"].includes(String(value.kind)));
}

// The unscoped legacy keys are deliberately never read, migrated or deleted.
export function readFinancialCache(
  storage: Pick<Storage, "getItem">,
  userId: string,
): FinancialSnapshot | null {
  try {
    const raw = storage.getItem(cacheKey(userId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || value.userId !== userId
      || !Array.isArray(value.entries) || !value.entries.every(isEntry)
      || !isRecord(value.lists)
      || !["envelopes", "investments", "accounts"].every((key) => isStrings((value.lists as Record<string, unknown>)[key]))) {
      return null;
    }
    return { entries: value.entries, lists: value.lists as FinancialLists };
  } catch {
    return null;
  }
}

export function writeFinancialCache(
  storage: Pick<Storage, "setItem">,
  userId: string,
  snapshot: FinancialSnapshot,
) {
  storage.setItem(cacheKey(userId), JSON.stringify({ version: 1, userId, ...snapshot }));
}
