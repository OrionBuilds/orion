/**
 * Pinned agent threads in Conversations: the owner's direct channel with Clara (and other agents).
 *
 * Routing lives in the database (migration 20261028070000_agent_threads.sql): a human message in an
 * agent thread creates one agent_thread_turns row, which is the idempotency key and the status the
 * thread shows. For Clara the trigger also POSTs the agent-thread function, which lands here:
 *
 *   handleClaraTurn  claims the turn atomically (sent -> working; a second delivery is a no-op), runs
 *                    Clara's owner brain over the ONE shared history (clara_owner_thread, channel
 *                    'chat'), and posts her reply into the thread as Clara. Every failure is posted
 *                    into the thread too, so nothing fails silently.
 *   sweepTurns       per-minute safety net: runs a 'sent' turn whose dispatch never arrived, and
 *                    fails (visibly) a turn that is too old to act on or that hung mid-run. A hung
 *                    run is never re-run: its tools may already have acted, and doing them twice is
 *                    worse than saying so.
 *
 * The other direction, one Clara history: owner<->Clara SMS/voice turns and Clara's own texts to the
 * owner are mirrored into the thread (mirrorToClaraThread) with metadata.source = 'sms' | 'voice',
 * which the routing trigger ignores, so a mirrored message never wakes Clara again.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";

/** A 'sent' turn this old was not delivered by the trigger's POST: the sweep runs it. */
export const RETRY_SENT_AFTER_MS = 20_000;
/** A 'sent' turn this old is stale; acting on it now would surprise the owner. */
export const GIVE_UP_SENT_AFTER_MS = 30 * 60_000;
/** A 'working' turn this old died mid-run. */
export const HUNG_AFTER_MS = 5 * 60_000;
/** Clara turns run per sweep (each can take up to ~100 s). */
const SWEEP_BATCH = 3;

export const NOT_ALLOWED_REPLY =
  "I can only take requests here from the account owner.";
export const HUNG_REPLY =
  "I lost track of that one partway through, so I may or may not have acted on it. Check before asking again.";
export const MISSED_REPLY = "I missed this message when it came in. Send it again if it still matters.";
export const failureReply = (detail: string) =>
  `I hit a snag and couldn't answer that (${detail.slice(0, 160)}). Nothing new was done; try again in a minute.`;

export interface ClaraTurnDeps {
  /** One owner turn through Clara's brain, over the shared history. */
  run: (orgId: string, text: string) => Promise<{ reply: string; failed: boolean }>;
  /** May this user give Clara instructions (the account owner or a SuperAdmin)? */
  canUseClara: (userId: string) => Promise<boolean>;
  now: () => Date;
  /** FRIDAY-mode turns (friday-thread.ts handleFridayTurn); the sweep retries them too. */
  runFridayTurn?: (messageId: string) => Promise<string>;
  /** Jason-mode turns (factory/jason-thread.ts handleJasonTurn); the sweep retries them too. */
  runJasonTurn?: (messageId: string) => Promise<string>;
}

/** Thread modes the OS answers itself (vs 'agent_request', which only queues for an agent's runner). */
export const OS_ANSWERED_MODES = ["clara", "friday", "jason"];

interface TurnRow {
  message_id: string; org_id: string; channel_id: string; agent_user_id: string; sender_id: string;
  mode: string; status: string;
}

export type TurnOutcome = "answered" | "failed" | "skipped";

/** Post a message into the thread as the agent. Returns its id, or null if it could not be written. */
export async function postAgentMessage(
  db: SupabaseClient, t: Pick<TurnRow, "channel_id" | "org_id" | "agent_user_id" | "message_id">, content: string,
  meta: Record<string, unknown> = {},
): Promise<string | null> {
  const { data, error } = await db.from("team_messages").insert({
    channel_id: t.channel_id, organization_id: t.org_id, sender_id: t.agent_user_id,
    content: content.slice(0, 20_000), reply_to_id: t.message_id,
    metadata: { source: "agent", ...meta },
  }).select("id").maybeSingle();
  if (error || !data) {
    console.error("[agent-thread] reply not posted:", error?.message ?? "no row");
    return null;
  }
  return (data as { id: string }).id;
}

async function finish(db: SupabaseClient, messageId: string, now: Date, status: "answered" | "failed", o: { replyId?: string | null; error?: string } = {}) {
  await db.from("agent_thread_turns").update({
    status, reply_message_id: o.replyId ?? null, error: o.error ?? null, updated_at: now.toISOString(),
  }).eq("message_id", messageId);
}

/** Answer one owner message in Clara's thread. Safe to call any number of times for the same message. */
export async function handleClaraTurn(db: SupabaseClient, d: ClaraTurnDeps, messageId: string): Promise<TurnOutcome> {
  // Claim: only the caller that moves it out of 'sent' does the work.
  const { data: claimed } = await db.from("agent_thread_turns")
    .update({ status: "working", attempts: 1, updated_at: d.now().toISOString() })
    .eq("message_id", messageId).eq("mode", "clara").eq("status", "sent")
    .select("message_id, org_id, channel_id, agent_user_id, sender_id, mode, status");
  const t = ((claimed ?? []) as TurnRow[])[0];
  if (!t) return "skipped";

  const { data: msg } = await db.from("team_messages").select("content, sender_id").eq("id", messageId).maybeSingle();
  const m = msg as { content: string; sender_id: string } | null;
  if (!m || !m.content?.trim()) {
    await finish(db, messageId, d.now(), "failed", { error: "message not found or empty" });
    return "failed";
  }

  if (!(await d.canUseClara(m.sender_id).catch(() => false))) {
    const replyId = await postAgentMessage(db, t, NOT_ALLOWED_REPLY, { kind: "refusal" });
    await finish(db, messageId, d.now(), "failed", { replyId, error: "sender is not the account owner or a SuperAdmin" });
    return "failed";
  }

  let r: { reply: string; failed: boolean };
  try {
    r = await d.run(t.org_id, m.content);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const replyId = await postAgentMessage(db, t, failureReply(detail), { kind: "error" });
    await finish(db, messageId, d.now(), "failed", { replyId, error: detail.slice(0, 500) });
    return "failed";
  }

  const replyId = await postAgentMessage(db, t, r.reply?.trim() || "I didn't catch that. What do you need?", r.failed ? { kind: "error" } : {});
  if (!replyId) {
    await finish(db, messageId, d.now(), "failed", { error: "Clara answered but the reply could not be posted" });
    return "failed";
  }
  await finish(db, messageId, d.now(), r.failed ? "failed" : "answered", { replyId, error: r.failed ? "brain failed" : undefined });
  return r.failed ? "failed" : "answered";
}

/** The per-minute safety net for the turns the OS answers itself (Clara and FRIDAY). */
export async function sweepTurns(db: SupabaseClient, d: ClaraTurnDeps): Promise<{ retried: number; missed: number; hung: number }> {
  const now = d.now();
  const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();

  // Too old to act on: fail it and say so (claimed by the conditional update, so posted once).
  const { data: old } = await db.from("agent_thread_turns")
    .update({ status: "failed", error: "not answered in time", updated_at: now.toISOString() })
    .in("mode", OS_ANSWERED_MODES).eq("status", "sent").lt("created_at", iso(GIVE_UP_SENT_AFTER_MS))
    .select("message_id, org_id, channel_id, agent_user_id, sender_id, mode, status");
  for (const t of (old ?? []) as TurnRow[]) {
    const replyId = await postAgentMessage(db, t, MISSED_REPLY, { kind: "system" });
    if (replyId) await db.from("agent_thread_turns").update({ reply_message_id: replyId }).eq("message_id", t.message_id);
  }

  // Died mid-run: fail it visibly, never re-run.
  const { data: hung } = await db.from("agent_thread_turns")
    .update({ status: "failed", error: "run did not finish", updated_at: now.toISOString() })
    .in("mode", OS_ANSWERED_MODES).eq("status", "working").lt("updated_at", iso(HUNG_AFTER_MS))
    .select("message_id, org_id, channel_id, agent_user_id, sender_id, mode, status");
  for (const t of (hung ?? []) as TurnRow[]) {
    const replyId = await postAgentMessage(db, t, HUNG_REPLY, { kind: "system" });
    if (replyId) await db.from("agent_thread_turns").update({ reply_message_id: replyId }).eq("message_id", t.message_id);
  }

  // The trigger's dispatch never arrived: run it now (handleClaraTurn claims, so a late dispatch is a no-op).
  const { data: pending } = await db.from("agent_thread_turns").select("message_id, mode")
    .in("mode", OS_ANSWERED_MODES).eq("status", "sent").lt("created_at", iso(RETRY_SENT_AFTER_MS))
    .order("created_at").limit(SWEEP_BATCH);
  let retried = 0;
  for (const p of (pending ?? []) as { message_id: string; mode: string }[]) {
    const outcome = p.mode === "friday"
      ? (d.runFridayTurn ? await d.runFridayTurn(p.message_id) : "skipped")
      : p.mode === "jason"
        ? (d.runJasonTurn ? await d.runJasonTurn(p.message_id) : "skipped")
        : await handleClaraTurn(db, d, p.message_id);
    if (outcome !== "skipped") retried++;
  }
  return { retried, missed: ((old ?? []) as unknown[]).length, hung: ((hung ?? []) as unknown[]).length };
}

/**
 * A thread-origin agent request nobody has claimed for a while: say so once, in the thread, as a
 * system note (instead of texting the owner). Returns true when a note was posted.
 */
export async function warnThreadStale(db: SupabaseClient, requestId: string, minutes: number, now: Date): Promise<boolean> {
  const { data } = await db.from("agent_thread_turns").update({ stale_warned_at: now.toISOString() })
    .eq("agent_request_id", requestId).is("stale_warned_at", null).eq("status", "queued")
    .select("message_id, org_id, channel_id, agent_user_id, sender_id, mode, status");
  const t = ((data ?? []) as TurnRow[])[0];
  if (!t) return false;
  return Boolean(await postAgentMessage(db, t,
    `Not picked up yet after ${minutes} minutes. The agent's runner may be down; it stays queued and will run when it's back.`,
    { kind: "system", agent_request_id: requestId }));
}

/**
 * Who may instruct the agents from the app (Clara's owner brain, FRIDAY's thread): the account owner
 * or a SuperAdmin. Their tools read the whole business (clients, mail, money, transcripts), so a role
 * permission (personal_assistant.view) is not enough. Mirrors the database gate
 * is_org_owner_or_superadmin (organizations.owner_user_id or SuperAdmin; never an agent), plus the
 * OWNER_USER_ID env for deployments that pin it.
 */
export async function canUseClara(db: SupabaseClient, userId: string, env?: Env): Promise<boolean> {
  const owner = env?.get("OWNER_USER_ID")?.trim();
  if (owner && owner === userId) return true;
  const { data: gate, error } = await db.rpc("is_org_owner_or_superadmin", { p_user: userId });
  if (!error && typeof gate === "boolean") return gate;
  // Before the owner-gate migration: SuperAdmin only.
  const { data: u } = await db.from("users").select("role_id").eq("id", userId).maybeSingle();
  const roleId = (u as { role_id: string | null } | null)?.role_id;
  if (!roleId) return false;
  const { data: role } = await db.from("roles").select("name").eq("id", roleId).maybeSingle();
  return (role as { name: string } | null)?.name === "SuperAdmin";
}

// ── one Clara history: mirror SMS/voice into the thread ─────────────────────────────────────

/** The owner's Clara thread for an org: OWNER_USER_ID's DM with Clara (else the org's oldest). */
export async function claraThreadChannel(
  db: SupabaseClient, env: Env, orgId: string,
): Promise<{ id: string; humanId: string; claraId: string } | null> {
  let claraId = env.get("CLARA_USER_ID")?.trim() || null;
  if (!claraId) {
    const { data } = await db.from("users").select("id").eq("organization_id", orgId).ilike("email", "clara@%").limit(1).maybeSingle();
    claraId = (data as { id: string } | null)?.id ?? null;
  }
  if (!claraId) return null;
  let q = db.from("team_channels").select("id, created_by").eq("organization_id", orgId).eq("agent_user_id", claraId);
  const owner = env.get("OWNER_USER_ID")?.trim();
  if (owner) q = q.eq("created_by", owner);
  const { data } = await q.order("created_at").limit(1).maybeSingle();
  const ch = data as { id: string; created_by: string } | null;
  return ch ? { id: ch.id, humanId: ch.created_by, claraId } : null;
}

export interface MirrorTurn { role: "user" | "clara"; content: string; source: "sms" | "voice"; kind?: string }

/** Copy SMS/voice turns into the Clara thread. Best-effort: never throws, never wakes Clara. */
export async function mirrorToClaraThread(db: SupabaseClient, env: Env, orgId: string, turns: MirrorTurn[]): Promise<number> {
  try {
    const ch = await claraThreadChannel(db, env, orgId);
    if (!ch) return 0;
    let n = 0;
    for (const t of turns) {
      if (!t.content?.trim()) continue;
      const { error } = await db.from("team_messages").insert({
        channel_id: ch.id, organization_id: orgId, sender_id: t.role === "user" ? ch.humanId : ch.claraId,
        content: t.content.slice(0, 20_000),
        metadata: { source: t.source, mirrored: true, ...(t.kind ? { clara_kind: t.kind } : {}) },
      });
      if (error) { console.warn("[agent-thread] mirror failed:", error.message); break; }
      n++;
    }
    return n;
  } catch (e) {
    console.warn("[agent-thread] mirror failed:", (e as Error).message);
    return 0;
  }
}

/** Clara texts to the owner that are NOT already in the thread as an owner-turn reply. */
export function shouldMirrorOwnerText(kind: string): boolean {
  return kind !== "owner_reply" && kind !== "owner_voice_followup";
}
