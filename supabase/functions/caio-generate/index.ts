/**
 * caio-generate: build or rebuild ONE CAIO document from the engagement's facts, registers and sources.
 *
 *   POST { engagement_id, template_number, system_key?, document_id?, job_id?, reason? }
 *
 * Callers: the owner (JWT; org owner / SuperAdmin only) from the CAIO tab, or the cron / service role (the
 * generator runs the same code in-process). A new document is a draft; an existing draft is regenerated with merge
 * (confirmed / edited text kept); an approved document is refused (`approved_use_revise`): revise it first.
 * Response: { ok, document_id, filled, unresolved:[{name,resolver}], needs_input:[{kind,key,label}], created }.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, isCronRequest, isServiceRoleRequest } from "../_shared/auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { canUseClara } from "../_shared/clara/agent-thread.ts";
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../_shared/claraConfig.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import { parseJsonObject } from "../_shared/friday/json-llm.ts";
import { generate } from "../_shared/caio/context.ts";
import { makeNarrativeAsk } from "../_shared/caio/narrative.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  const db = serviceClient();
  const trusted = isCronRequest(req) || isServiceRoleRequest(req);
  let callerOrg: string | null = null;
  let actorId: string | null = null;
  if (!trusted) {
    const ctx = await extractUserContext(req, db);
    if (!ctx) return json({ ok: false, error: "Unauthorized" }, 401);
    if (!(await canUseClara(db, ctx.id, denoEnv))) return json({ ok: false, error: "Only the account owner can generate CAIO documents" }, 403);
    callerOrg = ctx.orgId; actorId = ctx.id;
  }

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const engagementId = typeof b.engagement_id === "string" ? b.engagement_id : "";
  const templateNumber = Number(b.template_number);
  const systemKey = typeof b.system_key === "string" && b.system_key ? b.system_key : null;
  const documentId = typeof b.document_id === "string" && b.document_id ? b.document_id : null;
  const jobId = typeof b.job_id === "string" && b.job_id ? b.job_id : null;
  if (!UUID.test(engagementId) || !Number.isInteger(templateNumber) || templateNumber < 1 || templateNumber > 999) {
    return json({ ok: false, error: "engagement_id and template_number are required" }, 400);
  }
  if ((systemKey && !/^[A-Za-z0-9_-]{1,40}$/.test(systemKey)) || (documentId && !UUID.test(documentId))) return json({ ok: false, error: "Invalid system_key or document_id" }, 400);

  const { data: eng } = await db.from("caio_engagements").select("org_id").eq("id", engagementId).maybeSingle();
  const orgId = (eng as { org_id: string } | null)?.org_id;
  if (!orgId || (callerOrg && callerOrg !== orgId)) return json({ ok: false, error: "engagement_not_found" }, 404);

  const ask = makeNarrativeAsk({
    apiKey: denoEnv.get("ANTHROPIC_API_KEY")?.trim(),
    model: denoEnv.get("CAIO_MODEL")?.trim() || CLARA_MODEL, url: getAnthropicMessagesUrl(), version: ANTHROPIC_API_VERSION,
    fetcher: meteredFetch({ source: "caio-generate", agent: "clara", orgId, purpose: "caio narrative" }), parse: parseJsonObject,
  });
  try {
    const r = await generate({ db, ask, now: () => new Date(), timeoutMs: 35_000 }, {
      orgId, engagementId, templateNumber, systemKey, documentId, jobId, actorId,
      reason: typeof b.reason === "string" ? b.reason.slice(0, 200) : null,
    });
    return json(r, r.ok ? 200 : r.error === "approved_use_revise" ? 409 : 422);
  } catch (e) {
    console.error("[caio-generate]", String((e as Error).message).slice(0, 200));
    return json({ ok: false, error: "generation_failed" }, 500);
  }
});
