/** factory-runner — cron (every minute). One tick of the playbook engine (_shared/factory/runner.ts). Cron-only. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../_shared/claraConfig.ts";
import { meteredFetch } from "../_shared/ai-usage.ts";
import { parseJsonObject } from "../_shared/friday/json-llm.ts";
import { makeBudget } from "../_shared/friday/run-budget.ts";
import { factoryTick, type Ask } from "../_shared/factory/runner.ts";

const ask: Ask = async ({ system, prompt, timeoutMs, agent }) => {
  const key = denoEnv.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) return null;
  const f = meteredFetch({ source: "factory-runner", agent, purpose: "factory step" });
  try {
    const r = await f(getAnthropicMessagesUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
      body: JSON.stringify({
        model: denoEnv.get("FACTORY_MODEL")?.trim() || denoEnv.get("CLARA_OWNER_MODEL")?.trim() || CLARA_MODEL,
        max_tokens: 4000, system: `${system}\n\nReply with the JSON object only.`,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) { console.warn("[factory-runner] model HTTP", r.status); return null; }
    const j = await r.json() as { content?: { type: string; text?: string }[] };
    return parseJsonObject(j.content?.find((b) => b.type === "text")?.text ?? null);
  } catch (e) { console.warn("[factory-runner] model call failed:", (e as Error).message); return null; }
};

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if ((denoEnv.get("FACTORY_RUNNER") ?? "on").trim().toLowerCase() === "off") {
    return new Response(JSON.stringify({ success: true, skipped: "FACTORY_RUNNER=off" }), { headers: { "Content-Type": "application/json" } });
  }
  try {
    const res = await factoryTick({ db: serviceClient(), ask, budget: makeBudget(), claraUserId: denoEnv.get("CLARA_USER_ID")?.trim() || null });
    if (res.errors.length) console.warn("[factory-runner]", res.errors.slice(0, 5).join(" | "));
    return new Response(JSON.stringify({ success: true, ...res }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[factory-runner]", e);
    return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { status: 500 });
  }
});
