/**
 * agent-thread — the OS side of the pinned agent threads in Conversations: Clara's thread (her owner
 * brain), Jason's (marketing, _shared/factory/jason-thread.ts) and FRIDAY's thread (questions answered here from the OS's records; work queued for FRIDAY's
 * runner — see _shared/clara/friday-thread.ts).
 *
 * Called two ways, both with X-Cron-Secret (verify_jwt = false):
 *   { message_id }  by the trg_agent_thread_route_message trigger (pg_net) when the owner posts
 *                   in his Clara or FRIDAY thread;
 *   { sweep: true } every minute by the agent-thread-sweep cron (retries a dispatch that never
 *                   arrived; fails a stale or hung turn visibly).
 *
 * Replies 202 at once (pg_net waits 5 s) and finishes in the background. The work is idempotent:
 * the turn is claimed atomically, so a duplicate delivery never produces a second reply.
 * Only the account owner (OWNER_USER_ID) or a SuperAdmin may instruct her (canUseClara, checked
 * per turn before the brain runs, so every turn that reaches it is owner-verified).
 * Clara's reply comes from her owner brain (runOwnerBrain via ownerTurn), over the one shared
 * history in clara_owner_thread (channel 'chat'), and is posted into the thread as Clara.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { background, denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { claraNumberFor, ownerCtx } from "../_shared/clara/runtime.ts";
import { ownerTurn } from "../_shared/clara/owner-turn.ts";
import { type ClaraTurnDeps, canUseClara, handleClaraTurn, sweepTurns } from "../_shared/clara/agent-thread.ts";
import { type FridayTurnDeps, answerAsFriday, handleFridayTurn } from "../_shared/clara/friday-thread.ts";
import { type JasonTurnDeps, answerAsJason, handleJasonTurn } from "../_shared/factory/jason-thread.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);

  let body: { message_id?: unknown; sweep?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const db = serviceClient();
  const friday: FridayTurnDeps = {
    now: () => new Date(),
    canInstruct: (userId) => canUseClara(db, userId, denoEnv),
    answer: (t, text) => answerAsFriday(db, denoEnv, t, text),
  };
  const jason: JasonTurnDeps = {
    now: () => new Date(),
    canInstruct: (userId) => canUseClara(db, userId, denoEnv),
    answer: (t, text) => answerAsJason(db, denoEnv, t, text),
  };
  const deps: ClaraTurnDeps = {
    runFridayTurn: (id) => handleFridayTurn(db, friday, id),
    runJasonTurn: (id) => handleJasonTurn(db, jason, id),
    now: () => new Date(),
    canUseClara: (userId) => canUseClara(db, userId, denoEnv),
    run: async (orgId, text) => {
      const claraNumber = await claraNumberFor(db, denoEnv, orgId);
      const r = await ownerTurn(db, denoEnv, ownerCtx(db, denoEnv, { orgId, claraNumber, channel: "chat", ownerVerified: true }), text);
      return { reply: r.reply, failed: r.result?.failed ?? false };
    },
  };

  const messageId = typeof body.message_id === "string" ? body.message_id : null;
  let work: Promise<unknown>;
  if (messageId) {
    // The turn's mode says who answers: Clara's owner brain, or FRIDAY's thread (friday-thread.ts).
    work = (async () => {
      const { data } = await db.from("agent_thread_turns").select("mode").eq("message_id", messageId).maybeSingle();
      const mode = (data as { mode: string } | null)?.mode;
      const o = mode === "friday" ? await handleFridayTurn(db, friday, messageId)
        : mode === "jason" ? await handleJasonTurn(db, jason, messageId)
        : await handleClaraTurn(db, deps, messageId);
      console.log(`[agent-thread] ${messageId}: ${o}`);
    })();
  }
  else if (body.sweep === true) work = sweepTurns(db, deps).then((o) => { if (o.retried || o.missed || o.hung) console.log("[agent-thread] sweep", o); });
  else return json({ error: "message_id or sweep is required" }, 400);

  background(work);
  return json({ accepted: true }, 202);
});
