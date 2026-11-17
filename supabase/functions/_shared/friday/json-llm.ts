/**
 * Metered Anthropic JSON/text calls for the FRIDAY ports. One place for the request shape so the
 * pure modules only see `Ask` (JSON out) and `Say` (text out) functions, which tests replace.
 */
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../claraConfig.ts";
import { meteredFetch } from "../ai-usage.ts";
import type { Env } from "../clara/phones.ts";
import type { Ask } from "./portal-copy.ts";

/** Text-out model call; null on any failure (callers fall back to a deterministic template). */
export type Say = (o: { system: string; prompt: string; timeoutMs: number }) => Promise<string | null>;

export function makeSay(env: Env, source: string, f: typeof fetch = meteredFetch({ source, agent: "friday", purpose: source })): Say {
  return async ({ system, prompt, timeoutMs }) => {
    const key = env.get("ANTHROPIC_API_KEY")?.trim();
    if (!key) return null;
    try {
      const r = await f(getAnthropicMessagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
        body: JSON.stringify({
          model: env.get("FRIDAY_MODEL")?.trim() || CLARA_MODEL, max_tokens: 1500,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return null;
      const j = await r.json() as { content?: { type: string; text?: string }[] };
      return j.content?.find((b) => b.type === "text")?.text?.trim() || null;
    } catch { return null; }
  };
}

/** Pull the first JSON object out of a model reply. */
export function parseJsonObject(text: string | null): unknown | null {
  const m = (text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function makeAsk(say: Say): Ask {
  return async ({ system, prompt, timeoutMs }) => parseJsonObject(await say({ system: `${system}\n\nReply with the JSON object only.`, prompt, timeoutMs }));
}
