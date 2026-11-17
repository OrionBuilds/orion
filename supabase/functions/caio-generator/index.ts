/**
 * caio-generator: cron (every 5 min). Claims queued caio_generation_jobs (caio_claim_job, SKIP LOCKED) and runs the
 * same generate() code as caio-generate in-process. One job per tick when a model call was needed, up to three when
 * the documents needed none. Kill switch: secret CAIO_AUTOMATION=off. Per-engagement monthly model-call cap
 * (caio_engagements.ai_monthly_cap) blocks a job. Failures retry with back-off, then the job is 'failed'.
 * Nothing is approved, published or sent; the owner is told (once per engagement per day) that drafts are waiting.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../_shared/claraConfig.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import { parseJsonObject } from "../_shared/friday/json-llm.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
import { notifyDraftsReady, runJob, type Job } from "../_shared/caio/context.ts";
import { makeNarrativeAsk } from "../_shared/caio/narrative.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  if ((denoEnv.get("CAIO_AUTOMATION") ?? "on").trim().toLowerCase() === "off") return json({ success: true, skipped: "kill_switch" });

  const db = serviceClient();
  const budget = makeBudget();
  const touched = new Map<string, { orgId: string; client: string }>();
  const results: { job: string; status: string; reason?: string }[] = [];
  try {
    for (let n = 0; n < 3 && budget.canStart(15_000); n++) {
      const { data, error } = await db.rpc("caio_claim_job");
      if (error) { console.warn("[caio-generator] claim:", error.message.slice(0, 200)); break; }
      const job = data as Job | null;
      if (!job?.id) break;
      const ask = makeNarrativeAsk({
        apiKey: denoEnv.get("ANTHROPIC_API_KEY")?.trim(),
        model: denoEnv.get("CAIO_MODEL")?.trim() || CLARA_MODEL, url: getAnthropicMessagesUrl(), version: ANTHROPIC_API_VERSION,
        fetcher: meteredFetch({ source: "caio-generator", agent: "clara", orgId: job.org_id, purpose: "caio narrative" }), parse: parseJsonObject,
      });
      const out = await runJob({ db, ask, now: () => new Date(), timeoutMs: budget.timeout(35_000) }, job);
      results.push({ job: job.id, status: out.status, reason: out.reason });
      if (out.produced) touched.set(job.engagement_id, { orgId: job.org_id, client: out.client });
      if (out.modelCalls > 0) break;   // a model call used this tick's time: next job on the next tick
    }
    for (const [engagementId, t] of touched) {
      try {
        const number = await claraNumberFor(db, denoEnv, t.orgId);
        await notifyDraftsReady(db, (r) => notifyOwner(db, r, notifyDeps(db, denoEnv, t.orgId, number)), { engagementId, clientName: t.client, now: new Date() });
      } catch (e) { console.warn("[caio-generator] notify:", String((e as Error).message).slice(0, 200)); }
    }
    return json({ success: true, jobs: results });
  } catch (e) {
    console.error("[caio-generator]", String((e as Error).message).slice(0, 200));
    return json({ success: false, error: "tick_failed" }, 500);
  }
});
