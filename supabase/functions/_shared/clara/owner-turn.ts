/**
 * One owner turn, end to end: load the shared thread, run the brain, persist both sides.
 *
 * A phone turn has Twilio's ~15 s budget. If the brain isn't done inside `deadlineMs`, the caller
 * hears a short honest line and the SAME run keeps going in the background; when it finishes, the
 * outcome is delivered by text. Nothing is run twice and nothing is dropped.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type BrainResult, type StreamHooks, type Turn, runOwnerBrain } from "./owner-brain.ts";
import type { OwnerCtx } from "./owner-tools.ts";
import type { Env } from "./phones.ts";
import { mirrorToClaraThread } from "./agent-thread.ts";

/** How much shared history each channel reads: the app thread carries more ("what did I ask you yesterday?"). */
export const HISTORY = {
  sms: { hours: 24, turns: 16 },
  voice: { hours: 24, turns: 16 },
  chat: { hours: 72, turns: 30 },
} as const;

export async function loadThread(db: SupabaseClient, orgId: string, now: Date, channel: OwnerCtx["channel"] = "sms"): Promise<Turn[]> {
  const h = HISTORY[channel] ?? HISTORY.sms;
  const { data } = await db.from("clara_owner_thread").select("role, content, created_at")
    .eq("organization_id", orgId).gte("created_at", new Date(now.getTime() - h.hours * 3_600_000).toISOString())
    .order("created_at", { ascending: false }).limit(h.turns);
  return ((data ?? []) as { role: "user" | "clara"; content: string }[]).reverse().map((r) => ({ role: r.role, content: r.content }));
}

/** Pure: a transcript that is only sound tags ("[beep]", "[phone beeping]"): nobody said anything. */
export function soundOnly(text: string): boolean {
  return /^(\s*\[[^\]]*\]\s*)+$/.test(text);
}

/**
 * Pure: Clara's answer to speech an always-listening device picked up that was not meant for her ("not addressed
 * to me, so I'm staying quiet"). Such a turn is kept for her own context but is not conversation: it is neither
 * spoken back nor shown in the owner's thread.
 */
export function overheardReply(reply: string): boolean {
  return /\baddressed to me\b/i.test(reply);
}

async function persist(db: SupabaseClient, ctx: OwnerCtx, userText: string, r: BrainResult): Promise<void> {
  const base = { organization_id: ctx.orgId, channel: ctx.channel };
  const at = ctx.now().getTime();
  const { error } = await db.from("clara_owner_thread").insert([
    { ...base, role: "user", content: userText, tools: [], created_at: new Date(at).toISOString() },
    { ...base, role: "clara", content: r.reply, tools: r.tools.map((t) => ({ name: t.name, ok: t.ok })), created_at: new Date(at + 1).toISOString() },
  ]);
  if (error) console.error("[owner-turn] thread not saved:", error.message);
  // One Clara history: SMS/voice turns also show in the owner's Clara thread in Conversations.
  // App ('chat') turns already live there; mirrored rows never wake Clara again.
  if (ctx.channel !== "chat" && !(ctx.channel === "voice" && overheardReply(r.reply))) {
    await mirrorToClaraThread(db, ctx.env, ctx.orgId, [
      { role: "user", content: userText, source: ctx.channel },
      { role: "clara", content: r.reply, source: ctx.channel },
    ]);
  }
}

export interface OwnerTurnOpts {
  fetch?: typeof fetch;
  /** Return early with `deferredReply` if the brain takes longer; the run continues in the background. */
  deadlineMs?: number;
  /** Deliver the real outcome after a deferral (text it). */
  deliverLater?: (reply: string) => Promise<unknown>;
  /** Keep a promise alive after the response (EdgeRuntime.waitUntil). */
  keepAlive?: (p: Promise<unknown>) => void;
  /** Live call: stream the words as the model writes them. */
  stream?: StreamHooks;
  /** Model override for this turn (the live call uses a faster one). */
  model?: string;
}

export const DEFERRED_REPLY = "On it. I'll text you the result in a moment.";

export async function ownerTurn(
  db: SupabaseClient, env: Env, ctx: OwnerCtx, text: string, opts: OwnerTurnOpts = {},
): Promise<{ reply: string; deferred: boolean; result?: BrainResult }> {
  const history = await loadThread(db, ctx.orgId, ctx.now(), ctx.channel);
  const run = runOwnerBrain(env, ctx, history, text, { fetch: opts.fetch, stream: opts.stream, model: opts.model }).then(async (r) => { await persist(db, ctx, text, r); return r; });

  if (!opts.deadlineMs) {
    const r = await run;
    return { reply: r.reply, deferred: false, result: r };
  }
  let timer: number | undefined;
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), opts.deadlineMs) as unknown as number; });
  const winner = await Promise.race([run, timeout]);
  clearTimeout(timer);
  if (winner !== "timeout") return { reply: winner.reply, deferred: false, result: winner };

  const later = run.then((r) => opts.deliverLater?.(r.reply)).catch((e) => console.error("[owner-turn] deferred delivery failed:", e));
  opts.keepAlive?.(later);
  return { reply: DEFERRED_REPLY, deferred: true };
}
