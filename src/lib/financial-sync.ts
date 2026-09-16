import type { SupabaseClient } from "@supabase/supabase-js";

export type Currency = "ARS" | "USD" | "USDT";
export type Entry = {
  id: string;
  envelope: string;
  investment: string;
  account: string;
  currency: Currency;
  amount: number;
  currentValue: number;
  date: string;
  createdAt?: string;
  exchangeRate?: number;
  kind?: "aporte" | "retiro" | "valuacion";
};

export type FinancialLists = {
  envelopes: string[];
  investments: string[];
  accounts: string[];
};

type Client = Pick<SupabaseClient, "from">;

export async function saveFinancialEntry(
  client: Client,
  userId: string,
  entry: Entry,
  mode: "create" | "edit",
) {
  const values = {
    envelope: entry.envelope,
    investment: entry.investment,
    account: entry.account,
    currency: entry.currency,
    amount: entry.amount,
    current_value: entry.currentValue,
    exchange_rate: entry.exchangeRate ?? 1,
    entry_date: entry.date,
    kind: entry.kind || "aporte",
  };
  if (mode === "create") {
    const { error } = await client.from("financial_entries").insert({
      ...values,
      id: entry.id,
      user_id: userId,
      created_at: entry.createdAt || new Date().toISOString(),
    });
    if (error) {
      if (error.code === "23505") {
        throw new Error("Este movimiento ya existe. Recargá el historial para comprobar si el intento anterior se guardó.");
      }
      throw new Error(error.message);
    }
    return;
  }

  const { data, error } = await client
    .from("financial_entries")
    .update(values)
    .eq("user_id", userId)
    .eq("id", entry.id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("El movimiento ya no existe o no está disponible. Recargá el historial antes de continuar.");
  }
}

export async function deleteFinancialEntry(client: Client, userId: string, id: string) {
  const { error } = await client
    .from("financial_entries")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function changeFinancialEnvelope(
  client: Client,
  userId: string,
  oldName: string,
  newName: string,
) {
  const { error } = await client
    .from("financial_entries")
    .update({ envelope: newName })
    .eq("user_id", userId)
    .eq("envelope", oldName);
  if (error) throw new Error(error.message);
}

// Read the latest lists before applying this operation's changes. This does not
// replace database-level conflict control for simultaneous list updates.
export async function saveFinancialLists(
  client: Client,
  userId: string,
  fallback: FinancialLists,
  additions: Partial<FinancialLists> = {},
  envelopeChange?: { oldName: string; newName: string },
  assertCurrent: () => void = () => {},
): Promise<FinancialLists> {
  assertCurrent();
  const { data, error: readError } = await client
    .from("financial_lists")
    .select("envelopes, investments, accounts")
    .eq("user_id", userId)
    .maybeSingle();
  assertCurrent();
  if (readError) throw new Error(readError.message);
  const base: FinancialLists = data || fallback;
  const merge = (existing: string[], added: string[] = []) =>
    [...new Set([...existing, ...added].filter(Boolean))];
  const next = {
    envelopes: merge(base.envelopes, additions.envelopes),
    investments: merge(base.investments, additions.investments),
    accounts: merge(base.accounts, additions.accounts),
  };
  if (envelopeChange) {
    next.envelopes = merge(
      next.envelopes.filter((name) => name !== envelopeChange.oldName),
      [envelopeChange.newName],
    );
  }
  const { error } = await client.from("financial_lists").upsert({
    user_id: userId,
    ...next,
  });
  if (error) throw new Error(error.message);
  return next;
}
