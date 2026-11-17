/**
 * caio-extract — cron (X-Cron-Secret) every few minutes, or the owner's JWT with {source_id} to run one source now.
 * Reads cleared sources (process_status 'ready', extraction 'pending'), asks the model for proposals window by window, validates
 * every proposal server-side (verbatim quote, known keys, no secrets/PII) and writes caio_proposals. Nothing is accepted here.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { extractUserContext, isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { canUseClara } from "../_shared/clara/agent-thread.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../_shared/claraConfig.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import { parseJsonObject } from "../_shared/friday/json-llm.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
import { type Ask, runExtraction } from "../_shared/caio/extract.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const ask: Ask = async ({ system, prompt, timeoutMs }) => {
  const key = denoEnv.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) return null;
  const f = meteredFetch({ source: "caio-extract", agent: "clara", purpose: "caio extraction" });
  try {
    const r = await f(getAnthropicMessagesUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
      body: JSON.stringify({ model: CLARA_MODEL, max_tokens: 4000, temperature: 0, system, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) { console.warn("[caio-extract] model HTTP", r.status); return null; }
    const j = await r.json() as { content?: { type: string; text?: string }[] };
    return parseJsonObject(j.content?.find((b) => b.type === "text")?.text ?? null);
  } catch (e) { console.warn("[caio-extract] model call failed:", (e as Error).message.slice(0, 120)); return null; }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);
  const db = serviceClient();
  let body: { source_id?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const sourceId = typeof body.source_id === "string" ? body.source_id : undefined;

  let orgId: string | undefined;
  if (isCronRequest(req)) {
    if ((denoEnv.get("CAIO_AUTOMATION") ?? "").trim().toLowerCase() === "off") return json({ ok: true, skipped: "kill_switch" });
  } else {
    const user = await extractUserContext(req, db);
    if (!user) return json({ ok: false, error: "Unauthorized" }, 401);
    if (!(await canUseClara(db, user.id, denoEnv).catch(() => false))) return json({ ok: false, error: "Only the account owner can run extraction" }, 403);
    if (!sourceId) return json({ ok: false, error: "source_id is required" }, 400);
    orgId = user.orgId as string;
  }

  try {
    const run = await runExtraction({
      db, env: denoEnv, ask, budget: makeBudget(), now: () => new Date(),
      notify: async (org, n) => {
        await notifyOwner(db, { kind: n.kind, priority: "normal", text: n.text, dedupeKey: n.dedupeKey }, notifyDeps(db, denoEnv, org, await claraNumberFor(db, denoEnv, org)));
      },
    }, { sourceId, orgId });
    return json({ ok: true, ...run });
  } catch (e) {
    console.error("[caio-extract]", (e as Error).message.slice(0, 200));
    return json({ ok: false, error: "Extraction failed" }, 500);
  }
});
