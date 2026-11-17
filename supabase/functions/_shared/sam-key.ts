/**
 * The SAM.gov public API key. Entered per organization in Settings → Integrations → SAM.gov (sealed in
 * integration_connections like every other API-key integration); the SAM_GOV_API_KEY function secret is the
 * fallback so deployments that already set it keep working. Never logged or returned.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";
import { openSecret } from "./secrets.ts";

/** Per-request key (set once the caller's org is known) so concurrent requests for different orgs never share one. */
export const samKeyStore = new AsyncLocalStorage<string | null>();

export async function getSamApiKey(db: SupabaseClient, orgId: string): Promise<string | null> {
  try {
    const { data: integ } = await db.from("integrations").select("id").eq("org_id", orgId).eq("key", "sam_gov").maybeSingle();
    if (integ) {
      const { data: conn } = await db.from("integration_connections")
        .select("credentials_encrypted")
        .eq("integration_id", (integ as { id: string }).id).eq("org_id", orgId).eq("status", "connected").maybeSingle();
      const raw = await openSecret((conn as { credentials_encrypted: string | null } | null)?.credentials_encrypted);
      const key = raw ? ((JSON.parse(raw) as { api_key?: string }).api_key ?? "").trim() : "";
      if (key) return key;
    }
  } catch (e) {
    console.warn("[sam-key] could not read the SAM.gov connection:", (e as Error).message);
  }
  return Deno.env.get("SAM_GOV_API_KEY")?.trim() || null;
}

/** Probe used when a key is entered: one tiny search. 200 or 404 (no data) = valid; 401/403 = rejected. */
export async function validateSamKey(apiKey: string, f: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const mdy = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const url = `https://api.sam.gov/opportunities/v2/search?api_key=${encodeURIComponent(apiKey)}&postedFrom=${mdy}&postedTo=${mdy}&limit=1&offset=0`;
  const res = await f(url);
  await res.text();
  if (res.status === 200 || res.status === 404) return { ok: true };
  if (res.status === 401 || res.status === 403) return { ok: false, error: "SAM.gov rejected this key (keys expire every 90 days; generate a new one under sam.gov → Workspace → Profile → Public API Key)" };
  if (res.status === 429) return { ok: true }; // key recognised, daily quota used up
  return { ok: false, error: `SAM.gov returned ${res.status}` };
}
