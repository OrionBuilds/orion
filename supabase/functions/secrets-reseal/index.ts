import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getSupabaseClient, isCronRequest } from "../_shared/auth.ts";
import { isSealed, sealSecret } from "../_shared/secrets.ts";

/**
 * Seals third-party secrets stored as plain text before 2026-10-29 (_shared/secrets.ts). Idempotent:
 * sealed values are skipped. Cron-secret only (X-Cron-Secret), so it is run from SQL with pg_net and
 * the vault's cron_secret, and no key ever leaves the server. Returns counts, never values.
 *
 * Left alone on purpose: values already encrypted in another format with their own decryptor
 * (Stripe credentials in payment_provider_connections, Mailgun credentials via email-crypto), and
 * integration credentials that aren't plain JSON (nothing reads those, and their format is unknown).
 */
type Target = { table: string; column: string; only?: (row: Record<string, unknown>) => boolean };

const TARGETS: Target[] = [
  { table: "integration_connections", column: "access_token_encrypted" },
  { table: "integration_connections", column: "refresh_token_encrypted" },
  {
    table: "integration_connections",
    column: "credentials_encrypted",
    only: (r) => typeof r.credentials_encrypted === "string" && /^\s*\{/.test(r.credentials_encrypted),
  },
  { table: "llm_providers", column: "api_key_encrypted" },
  { table: "elevenlabs_connection", column: "api_key_encrypted" },
  { table: "payment_provider_connections", column: "access_token_encrypted" },
  { table: "payment_provider_connections", column: "refresh_token_encrypted" },
  { table: "outgoing_webhooks", column: "signing_secret_encrypted" },
];

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  const supabase = getSupabaseClient();
  const report: Record<string, { sealed: number; skipped: number; failed: number }> = {};

  for (const t of TARGETS) {
    const key = `${t.table}.${t.column}`;
    report[key] = { sealed: 0, skipped: 0, failed: 0 };
    const cols = t.column === "credentials_encrypted" ? "id, credentials_encrypted, credentials_iv" : `id, ${t.column}`;
    const { data, error } = await supabase.from(t.table).select(cols).not(t.column, "is", null);
    if (error) {
      report[key].failed = -1;
      console.error(`[secrets-reseal] ${key}: ${error.message}`);
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const value = row[t.column] as string;
      if (!value || isSealed(value) || (t.only && !t.only(row))) {
        report[key].skipped++;
        continue;
      }
      const patch: Record<string, unknown> = { [t.column]: await sealSecret(value) };
      // The old plain-JSON credentials sat next to a random, unused "IV".
      if (t.column === "credentials_encrypted") patch.credentials_iv = null;
      const { error: upErr } = await supabase.from(t.table).update(patch).eq("id", row.id).eq(t.column, value);
      if (upErr) {
        report[key].failed++;
        console.error(`[secrets-reseal] ${key} ${row.id}: ${upErr.message}`);
      } else {
        report[key].sealed++;
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, report }), { headers: { "Content-Type": "application/json" } });
});
