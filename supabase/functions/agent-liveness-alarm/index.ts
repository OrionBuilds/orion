/**
 * agent-liveness-alarm — the off-box dead-man's switch for the agent workstation.
 *
 * Invoked by pg_cron every 10 minutes (see 20260801060001_agent_liveness_alarm.sql). Reads the
 * heartbeats CLARA / FRIDAY write on every OS task poll and texts the owner when they stop.
 *
 * Why this lives here and not on the box: all four Windows services depend on interactive
 * auto-login, and an agent that never started cannot report that it never started. Every
 * on-box check is blind to exactly the outage that matters most. This function runs in
 * Supabase, so the only shared dependency with the thing it watches is the network between
 * them — which is itself one of the outages it detects.
 *
 * Alerting is transition-based (quiet until something changes) with a slow re-nag, because an
 * alarm that fires every tick gets muted and then the next real one is missed too.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { getTwilioEnvCreds, sendTwilioSms } from "../_shared/twilio.ts";
import { corsHeaders } from "../_shared/cors.ts";

/** How long without a poll before an agent counts as down. Their own cadence is 1-2 min. */
const STALE_MINUTES = Number(Deno.env.get("AGENT_LIVENESS_STALE_MINUTES") ?? "20");
/** While an agent stays down, re-text at most this often so a long outage doesn't go quiet. */
const RENAG_HOURS = Number(Deno.env.get("AGENT_LIVENESS_RENAG_HOURS") ?? "6");
/**
 * Re-nag cadence when EVERY agent is down, which is a different incident from one being stuck.
 *
 * Six hours between reminders meant the 2026-08-03 total outage was announced once at 04:40 and
 * then went quiet until 10:40 — indistinguishable, from the phone, from a single service being
 * unhappy. Thirty minutes is loud enough to be a real siren and slow enough not to be spam.
 */
const TOTAL_OUTAGE_RENAG_MINUTES = Number(Deno.env.get("AGENT_LIVENESS_TOTAL_OUTAGE_RENAG_MINUTES") ?? "30");
/** Whose phone to page. Read from public.users so it survives a number change with no redeploy. */
const OWNER_EMAIL = Deno.env.get("OWNER_ALERT_EMAIL") ?? "";
/**
 * How far past next_run_at a schedule may sit before it counts as not running.
 *
 * Generous on purpose. Agents poll on a ~60s tick, a claimed run can take minutes, and a task that
 * legitimately runs long would otherwise flap. The failure this catches is measured in hours, not
 * minutes — the incident that motivated it ran 34 hours — so an hour of slack costs nothing and
 * buys immunity from every normal source of lateness.
 */
const SCHEDULE_OVERDUE_MINUTES = Number(Deno.env.get("AGENT_SCHEDULE_OVERDUE_MINUTES") ?? "60");

interface HeartbeatRow {
  agent_user_id: string;
  last_poll_at: string | null;
}
interface StateRow {
  agent_user_id: string;
  alerting: boolean;
  last_alert_at: string | null;
  schedules_alerting: boolean | null;
  schedules_alert_at: string | null;
  tunnel_alerting: boolean | null;
  tunnel_alert_at: string | null;
}

/**
 * Public reachability probes — "can the outside world get to this agent?"
 *
 * A HEARTBEAT PROVES THE AGENT IS ALIVE, NOT THAT ANYONE CAN REACH IT. On 2026-08-04 CLARA's app
 * was serving perfectly on 127.0.0.1:3939 and heartbeating normally while her published phone
 * number, the website chat widget and inbound SMS all returned Cloudflare 1033 — the ClaraTunnel
 * service had stopped. Every check in the estate was green. The owner found it by using it.
 *
 * WHY THIS EXACT PATH. Cloudflare Access sits in front of these hostnames and answers 302 at the
 * edge, BEFORE the tunnel is consulted — so probing `/` cannot tell "tunnel down" from "tunnel up
 * but gated". The Twilio webhook paths are Access-BYPASSED (they must be: Twilio arrives with no
 * credential), so a request to one actually traverses the tunnel. Verified empirically during the
 * outage: with the tunnel stopped CLARA's returned 530 while every gated path returned 302, and
 * FRIDAY's (tunnel up) returned 405.
 *
 * It is also the path that MATTERS: if this 530s, the agent's phone line is genuinely dead. The
 * probe tests the real capability rather than a proxy for it.
 */
// No public tunnel probes remain. CLARA's and FRIDAY's own hostnames are retired (2026-10-22):
// Clara's phone line now routes Twilio -> Supabase edge functions directly (no separate Clara host
// tunnel), and FRIDAY is a headless OS worker with no public phone. Probing those hostnames would
// 530 forever and page the owner about services we took down on purpose. If a phone-reachability check is
// wanted again, probe the Twilio number / the OS edge function, not the old tunnel.
const PUBLIC_PROBES: Record<string, string> = {};

/** A retired agent (users.status 'inactive') with a leftover heartbeat row must never page the owner —
 *  same reasoning as the owner skip below. Agents are retired by data, not by name in code. Live
 *  agents stay watched by heartbeat; only their obsolete public tunnel probes were removed
 *  (PUBLIC_PROBES above) — the clara./friday. hostnames are retired. */
const RETIRED_STATUS = "inactive";

/**
 * True when the tunnel is DOWN.
 *
 * Only 530 counts. Cloudflare returns it for 1033 ("tunnel not connected"), which is the specific
 * condition worth paging about. A 405, 200, 403 or 302 all mean something answered — the tunnel is
 * carrying traffic — and must not alarm. A network error reaching Cloudflare at all is NOT treated
 * as the agent being down: that is this function's own connectivity, and blaming the agent for it
 * would be the same confidently-wrong diagnosis this alarm already had to have removed once.
 */
async function tunnelDown(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
    return r.status === 530;
  } catch {
    return false;
  }
}
interface ScheduleRow {
  agent_user_id: string;
  agent_slug: string;
  task_key: string;
  next_run_at: string | null;
  mode: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Rehearsal mode. An alarm nobody has ever seen fire is an assumption, not a safety net, but
    // the only honest live test is a real 3am siren. `dryRun` resolves the recipient and the
    // Twilio credentials — the two things that actually break silently — composes the real
    // message, and stops short of sending. State is left untouched so a rehearsal cannot consume
    // the transition that a real outage needs.
    const body = await req.json().catch(() => null);
    const dryRun = body?.dryRun === true;
    /**
     * Rehearse the message that only a real total outage would produce.
     *
     * The text sent on 2026-08-03 was WRONG, and nobody could have known before it fired, because
     * the all-down branch is only reachable when all three agents are genuinely stale. A safety net
     * whose most important string is unreadable until the emergency is not a safety net.
     *
     * Treats every heartbeat as stale so the composer runs the total-outage branch. dryRun only —
     * ignored otherwise — and dryRun already suppresses every state write, so a rehearsal can never
     * consume the transition a real outage needs.
     */
    const simulateAllDown = dryRun && body?.simulateAllDown === true;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: rawBeats, error: beatsErr } = await supabase
      .from("agent_heartbeats")
      .select("agent_user_id, last_poll_at");
    if (beatsErr) throw new Error(`heartbeats read failed: ${beatsErr.message}`);

    // No heartbeat rows at all means no agent has ever polled — a fresh database, not an outage.
    // Alarming here would page on day one of any new environment.
    if (!rawBeats?.length) {
      return json({ ok: true, watched: 0, note: "no heartbeats recorded yet" });
    }

    // Resolve identities for the message body. Agents are addressed by email because that is what
    // they authenticate as; a bare uuid in a 2am text is useless.
    const rawIds = (rawBeats as HeartbeatRow[]).map((b) => b.agent_user_id);
    const { data: users, error: usersErr } = await supabase.from("users").select("id, email, status").in("id", rawIds);
    // Without identities the owner/retired filter below can't run, and a leftover retired agent's row
    // would count toward outage math — fail through the handler rather than page on a guess.
    if (usersErr) throw new Error(`users read failed: ${usersErr.message}`);
    const emailById = new Map<string, string>((users ?? []).map((u) => [u.id as string, u.email as string]));
    const retiredIds = new Set<string>((users ?? []).filter((u) => u.status === RETIRED_STATUS).map((u) => u.id as string));

    // The watched set, decided BEFORE any outage math: the owner's own identity and retired agents
    // (a leftover heartbeat row) never count toward "everything is down", the re-page cadence or the
    // "other agents are polling" wording — they would otherwise mask or misstate a real outage.
    const beats = (rawBeats as HeartbeatRow[]).filter((b) => {
      const email = emailById.get(b.agent_user_id);
      return !(email === OWNER_EMAIL || retiredIds.has(b.agent_user_id));
    });
    if (!beats.length) {
      return json({ ok: true, watched: 0, note: "no watched agents (only owner/retired heartbeats)" });
    }
    const ids = beats.map((b) => b.agent_user_id);

    const { data: states } = await supabase
      .from("agent_liveness_state")
      .select("agent_user_id, alerting, last_alert_at, schedules_alerting, schedules_alert_at, tunnel_alerting, tunnel_alert_at")
      .in("agent_user_id", ids);
    const stateById = new Map<string, StateRow>((states ?? []).map((s) => [s.agent_user_id, s as StateRow]));

    // What the supervisors say is actually wrong. Until 2026-08-03 this function could only observe
    // "no heartbeat" and then speculate about the cause in the text it sent — and on the outage that
    // motivated this it speculated WRONG, telling the owner the workstation had probably rebooted
    // when in fact the box was up and `next start` was failing on a missing production build. He
    // acted on that and lost the morning. Now the supervisor's own last error is quoted verbatim.
    const { data: supStates } = await supabase
      .from("agent_supervisor_state")
      .select("agent_slug, consecutive_fails, last_error, last_failure_at");
    const supervisorErrors = (supStates ?? [])
      .filter((s) => (s.consecutive_fails as number) > 0 && s.last_error)
      .map((s) => `${s.agent_slug}: ${String(s.last_error).slice(0, 180)}`);

    const now = Date.now();
    const staleMs = STALE_MINUTES * 60_000;

    // Severity scales with blast radius, so the re-nag cadence has to as well.
    //
    // 6 hours is right for ONE agent down: the others still work, and a text every six hours is
    // enough to stop it being forgotten. It is badly wrong when EVERYTHING is down — on
    // 2026-08-03 that meant one text at 04:40 and the next not due until 10:40, so a total estate
    // outage looked exactly as urgent as a single stuck service. A full outage now re-nags every
    // 30 minutes until it recovers.
    const totalOutage = simulateAllDown || (beats as HeartbeatRow[])
      .every((b) => Date.now() - (b.last_poll_at ? Date.parse(b.last_poll_at) : 0) > staleMs);
    const renagMs = totalOutage ? TOTAL_OUTAGE_RENAG_MINUTES * 60_000 : RENAG_HOURS * 3_600_000;

    const wentDown: string[] = [];
    const cameBack: string[] = [];
    const stillDown: string[] = [];
    const downMinutes = new Map<string, number>();
    /** Agents currently heartbeating — the only ones whose idle schedules mean anything. */
    const healthyAgents = new Set<string>();

    for (const beat of beats as HeartbeatRow[]) {
      // Label by the full email, not the localpart. These are OS sign-in identities rather than
      // agent names, and the two have already diverged once: CLARA ran as the owner's address until 2026-08-02.
      // "no heartbeat from <owner>" would read as a person being down; the full address reads as the
      // identity it actually is, and stays correct if they diverge again.
      const label = emailById.get(beat.agent_user_id) ?? beat.agent_user_id.slice(0, 8);
      // Skip the owner's own identity (2026-10-02). A heartbeat row for the owner's address
      // survived from before CLARA split out of his user on 2026-08-02; nothing writes to it any
      // more, so the alarm paged him every 6h about himself. The owner is never an agent to watch.
      if (label === OWNER_EMAIL || retiredIds.has(beat.agent_user_id)) continue;
      // A null last_poll_at is a row that exists but has never recorded a poll. Treat it as stale
      // rather than skipping it — a heartbeat that never ticks is exactly the thing we watch for.
      const lastPoll = beat.last_poll_at ? Date.parse(beat.last_poll_at) : 0;
      const stale = simulateAllDown || now - lastPoll > staleMs;
      const prior = stateById.get(beat.agent_user_id);
      const wasAlerting = prior?.alerting ?? false;

      if (stale) downMinutes.set(label, Math.round((now - lastPoll) / 60_000));
      else healthyAgents.add(beat.agent_user_id);

      if (stale && !wasAlerting) {
        wentDown.push(label);
        if (!dryRun) await upsertState(supabase, beat.agent_user_id, { alerting: true, last_alert_at: new Date().toISOString(), last_stale_at: new Date().toISOString() });
      } else if (stale && wasAlerting) {
        const since = prior?.last_alert_at ? Date.parse(prior.last_alert_at) : 0;
        if (now - since > renagMs) {
          stillDown.push(label);
          if (!dryRun) await upsertState(supabase, beat.agent_user_id, { alerting: true, last_alert_at: new Date().toISOString() });
        }
      } else if (!stale && wasAlerting) {
        cameBack.push(label);
        if (!dryRun) await upsertState(supabase, beat.agent_user_id, { alerting: false, last_recovery_at: new Date().toISOString() });
      } else if (!prior && !dryRun) {
        // Healthy and unseen — record the row so the first real outage is a transition, not a
        // first-sighting that has nothing to compare against.
        await upsertState(supabase, beat.agent_user_id, { alerting: false });
      }
    }

    // ── Polling but claiming nothing ─────────────────────────────────────────────────────────
    // A heartbeat proves the agent is alive, not that it is doing anything. Those came apart on
    // 2026-08-02: CLARA's identity moved to clara@ while agent_task_schedules still pointed at
    // the owner, and since claim_due_agent_task_runs() claims `WHERE agent_user_id = auth.uid()` she
    // polled every minute, claimed nothing, and reported success. 34 hours, six overdue schedules,
    // zero runs, every indicator green.
    //
    // ONLY checked for agents whose heartbeat is healthy. If an agent is down its schedules are of
    // course overdue — that is a symptom of the outage already being reported above, and paging
    // twice for one fault is how an alarm gets muted. Restricting it to live agents is what makes
    // this signal rather than noise: "alive AND idle" is a distinct failure with a distinct cause.
    const overdueByAgent = new Map<string, string[]>();
    const scheduleCutoff = new Date(now - SCHEDULE_OVERDUE_MINUTES * 60_000).toISOString();
    const { data: schedules } = await supabase
      .from("agent_task_schedules")
      .select("agent_user_id, agent_slug, task_key, next_run_at, mode")
      .neq("mode", "off")               // an off schedule is not supposed to run
      .lt("next_run_at", scheduleCutoff);

    for (const sched of (schedules ?? []) as ScheduleRow[]) {
      // Skip schedules belonging to an agent we already know is down, and to any agent with no
      // heartbeat row at all (nothing to compare against — it has never polled).
      if (!healthyAgents.has(sched.agent_user_id)) continue;
      const list = overdueByAgent.get(sched.agent_user_id) ?? [];
      list.push(sched.task_key);
      overdueByAgent.set(sched.agent_user_id, list);
    }

    const idleAgents: string[] = [];
    const idleRecovered: string[] = [];
    for (const [agentId, keys] of overdueByAgent) {
      const prior = stateById.get(agentId);
      if (prior?.schedules_alerting) continue;   // already reported; stays quiet until it recovers
      const label = emailById.get(agentId) ?? agentId.slice(0, 8);
      idleAgents.push(`${label}: ${keys.length} overdue (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""})`);
      if (!dryRun) await upsertState(supabase, agentId, { schedules_alerting: true, schedules_alert_at: new Date().toISOString() });
    }
    // Recovery: was flagged idle, has no overdue schedules now.
    for (const [agentId, st] of stateById) {
      if (!st.schedules_alerting || overdueByAgent.has(agentId)) continue;
      idleRecovered.push(emailById.get(agentId) ?? agentId.slice(0, 8));
      if (!dryRun) await upsertState(supabase, agentId, { schedules_alerting: false });
    }

    // ── Publicly unreachable ─────────────────────────────────────────────────────────────────────
    // Checked for EVERY agent regardless of heartbeat, because the whole point is that these two
    // states are independent — a perfectly healthy agent behind a stopped tunnel is invisible to
    // every other check here, and that is exactly what happened on 2026-08-04.
    const tunnelDownNow: string[] = [];
    const tunnelBack: string[] = [];
    for (const beat of beats as HeartbeatRow[]) {
      const label = emailById.get(beat.agent_user_id) ?? "";
      const probe = PUBLIC_PROBES[label];
      if (!probe) continue;
      const down = await tunnelDown(probe);
      const prior = stateById.get(beat.agent_user_id);
      const wasDown = prior?.tunnel_alerting ?? false;

      if (down && !wasDown) {
        tunnelDownNow.push(label);
        if (!dryRun) await upsertState(supabase, beat.agent_user_id, { tunnel_alerting: true, tunnel_alert_at: new Date().toISOString() });
      } else if (down && wasDown) {
        // Re-nag on the same cadence as a total outage: an agent nobody can reach is an outage as
        // far as anyone outside this building is concerned.
        const since = prior?.tunnel_alert_at ? Date.parse(prior.tunnel_alert_at) : 0;
        if (now - since > TOTAL_OUTAGE_RENAG_MINUTES * 60_000) {
          tunnelDownNow.push(label);
          if (!dryRun) await upsertState(supabase, beat.agent_user_id, { tunnel_alerting: true, tunnel_alert_at: new Date().toISOString() });
        }
      } else if (!down && wasDown) {
        tunnelBack.push(label);
        if (!dryRun) await upsertState(supabase, beat.agent_user_id, { tunnel_alerting: false });
      }
    }

    const messages: string[] = [];
    if (tunnelDownNow.length) {
      messages.push(
        `🚨 UNREACHABLE from the internet — ${tunnelDownNow.join(", ")}. The app is fine and still ` +
          `heartbeating; the Cloudflare tunnel is not connected (error 1033), so the published phone ` +
          `number, inbound SMS and the website chat are all dead. Fix: start the tunnel service ` +
          `(ClaraTunnel / FridayTunnel), not the app.`,
      );
    }
    if (tunnelBack.length) {
      messages.push(`✅ Reachable again: ${tunnelBack.join(", ")}.`);
    }
    if (wentDown.length) {
      const detail = wentDown.map((a) => `${a} (${downMinutes.get(a)}m)`).join(", ");
      if (wentDown.length === beats.length) {
        // Two genuinely different situations, and the old text asserted the wrong one as fact.
        //
        // Supervisors reporting  → the box is UP and its supervisors are alive enough to phone home;
        //                          the apps cannot start. Quote their error and stop guessing.
        // Silence               → nothing on that machine is talking to us at all, which is the
        //                          case the reboot theory was written for. Say it as a possibility.
        messages.push(
          supervisorErrors.length
            ? `🚨 ALL AGENTS DOWN — no heartbeat from ${detail}. The box is UP and the supervisors are retrying; the apps will not start. Reported cause — ${supervisorErrors.join(" | ")}`
            : `🚨 ALL AGENTS DOWN — no heartbeat from ${detail}, and their supervisors are not reporting either, so nothing on that machine is reachable. Likely the workstation is off or rebooted without getting back to a logged-in desktop.`,
        );
      } else {
        messages.push(
          `🚨 Agent down — no heartbeat from ${detail}. The other agents are still polling, so the box is up and this is that service alone.` +
            (supervisorErrors.length ? ` Reported cause — ${supervisorErrors.join(" | ")}` : ""),
        );
      }
    }
    if (stillDown.length) {
      const window = totalOutage ? `${TOTAL_OUTAGE_RENAG_MINUTES}m` : `${RENAG_HOURS}h`;
      messages.push(
        `🚨 Still down after ${window}: ${stillDown.map((a) => `${a} (${downMinutes.get(a)}m)`).join(", ")}.` +
          (supervisorErrors.length ? ` Reported cause — ${supervisorErrors.join(" | ")}` : ""),
      );
    }
    if (cameBack.length) {
      messages.push(`✅ Back up: ${cameBack.join(", ")}.`);
    }
    if (idleAgents.length) {
      messages.push(
        `⚠️ Alive but running nothing — ${idleAgents.join("; ")}. The agent is polling fine, so this is not an outage: its scheduled work is not being claimed. Most likely its schedules point at a different agent_user_id than the identity it signs in as.`,
      );
    }
    if (idleRecovered.length) {
      messages.push(`✅ Scheduled work flowing again: ${idleRecovered.join(", ")}.`);
    }

    const text = messages.join(" ");

    if (dryRun) {
      const rehearsal = await rehearsePage(supabase);
      return json({
        ok: true,
        dryRun: true,
        simulateAllDown,
        watched: beats.length,
        totalOutage,
        supervisorErrors,
        tunnelDownNow,
        tunnelBack,
        wentDown,
        stillDown,
        cameBack,
        idleAgents,
        idleRecovered,
        wouldSend: text || null,
        ...rehearsal,
      });
    }

    let sent = false;
    if (messages.length) sent = await pageOwner(supabase, text);

    // `last_alert_at` is stamped inside the loop above, BEFORE this send — so on its own it records
    // that we decided to alert, not that a text arrived. That distinction matters: the whole value
    // of this alarm is the phone buzzing, and a state row reading "alerted" while Twilio rejected
    // the message is precisely the kind of comfortable lie this estate keeps producing.
    //
    // If the send failed, roll the alerting flag back so the NEXT run treats these as fresh
    // transitions and tries again immediately, instead of filing them under "already told him" and
    // waiting out the whole re-nag window in silence.
    if (messages.length && !sent && (wentDown.length || stillDown.length)) {
      console.error("[agent-liveness-alarm] page FAILED to send — rolling back alerting state so the next run retries");
      for (const beat of beats as HeartbeatRow[]) {
        const label = emailById.get(beat.agent_user_id) ?? beat.agent_user_id.slice(0, 8);
        if (wentDown.includes(label) || stillDown.includes(label)) {
          await upsertState(supabase, beat.agent_user_id, { alerting: false, last_alert_at: null });
        }
      }
    }

    return json({
      ok: true,
      watched: beats.length,
      totalOutage,
      supervisorErrors,
      tunnelDownNow,
      tunnelBack,
      wentDown,
      stillDown,
      cameBack,
      idleAgents,
      idleRecovered,
      paged: sent,
    });
  } catch (e) {
    console.error("[agent-liveness-alarm]", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * Pick a number to page FROM.
 *
 * The obvious implementation — trust `TWILIO_DEFAULT_FROM_NUMBER` — is what the first rehearsal
 * of this function proved is broken: that variable is unset, `phone_settings.default_sms_number_id`
 * is NULL, and there is no messaging service, so every send would have failed at Twilio's
 * "Missing from" check while the alarm reported success. An alarm with no sender is worse than no
 * alarm, because it looks like one.
 *
 * So this falls all the way through to *any* active number. A page arriving from an unexpected
 * caller ID is a trivial problem; a page that never arrives is the whole failure this exists to
 * prevent. Returns the messaging service when one is configured, since that takes precedence in
 * sendTwilioSms.
 */
async function resolveSender(
  supabase: ReturnType<typeof createClient>,
  creds: NonNullable<ReturnType<typeof getTwilioEnvCreds>>,
): Promise<{ from?: string; messagingServiceSid?: string; source: string }> {
  if (creds.messagingServiceSid) return { messagingServiceSid: creds.messagingServiceSid, source: "messaging-service" };

  const override = Deno.env.get("AGENT_LIVENESS_FROM_NUMBER")?.trim();
  if (override) return { from: override, source: "env-override" };

  if (creds.defaultFromNumber) return { from: creds.defaultFromNumber, source: "twilio-env-default" };

  const { data: settings } = await supabase
    .from("phone_settings")
    .select("twilio_numbers!default_sms_number_id(phone_number)")
    .maybeSingle();
  const configured = (settings as { twilio_numbers?: { phone_number?: string } } | null)?.twilio_numbers?.phone_number;
  if (configured) return { from: configured, source: "phone_settings-default" };

  const { data: anyNumber } = await supabase
    .from("twilio_numbers")
    .select("phone_number")
    .eq("status", "active")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const fallback = anyNumber?.phone_number as string | undefined;
  return fallback ? { from: fallback, source: "first-active-number" } : { source: "none" };
}

/**
 * Everything pageOwner does except the send: prove the credentials exist, a sender resolves, and
 * the owner's number resolves. The number is returned masked — a health endpoint should never
 * print a phone number in full, and the last four digits are enough to confirm it is the right one.
 */
async function rehearsePage(
  supabase: ReturnType<typeof createClient>,
): Promise<{ twilioConfigured: boolean; sender: string | null; senderSource: string; ownerPhone: string | null }> {
  const creds = getTwilioEnvCreds();
  const { data: owner } = await supabase
    .from("users")
    .select("phone")
    .eq("email", OWNER_EMAIL)
    .maybeSingle();
  const to = (owner?.phone as string | null)?.trim() ?? null;
  const sender = creds ? await resolveSender(supabase, creds) : { source: "no-credentials" };
  const senderId = "messagingServiceSid" in sender && sender.messagingServiceSid
    ? "messaging-service"
    : ("from" in sender && sender.from ? `••••${sender.from.slice(-4)}` : null);
  return {
    twilioConfigured: Boolean(creds?.accountSid && creds?.authToken),
    sender: senderId,
    senderSource: sender.source,
    ownerPhone: to ? `••••${to.slice(-4)}` : null,
  };
}

async function upsertState(
  supabase: ReturnType<typeof createClient>,
  agentUserId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("agent_liveness_state")
    .upsert({ agent_user_id: agentUserId, updated_at: new Date().toISOString(), ...patch }, { onConflict: "agent_user_id" });
  if (error) console.error("[agent-liveness-alarm] state upsert failed", agentUserId, error.message);
}

/**
 * Text the owner. Returns whether Twilio accepted it — the caller reports this rather than
 * assuming, because a silent send failure here would defeat the entire purpose of the alarm.
 */
async function pageOwner(supabase: ReturnType<typeof createClient>, body: string): Promise<boolean> {
  const creds = getTwilioEnvCreds();
  if (!creds) {
    console.error("[agent-liveness-alarm] no Twilio credentials — cannot page:", body);
    return false;
  }

  const { data: owner } = await supabase
    .from("users")
    .select("phone")
    .eq("email", OWNER_EMAIL)
    .maybeSingle();
  const to = (owner?.phone as string | null)?.trim();
  if (!to) {
    console.error(`[agent-liveness-alarm] no phone on ${OWNER_EMAIL} — cannot page:`, body);
    return false;
  }

  const sender = await resolveSender(supabase, creds);
  if (!sender.from && !sender.messagingServiceSid) {
    console.error("[agent-liveness-alarm] no sender number available — cannot page:", body);
    return false;
  }

  const res = await sendTwilioSms({
    accountSid: creds.accountSid,
    authToken: creds.authToken,
    to,
    body,
    from: sender.from,
    messagingServiceSid: sender.messagingServiceSid,
  });
  if (!res.ok) console.error("[agent-liveness-alarm] Twilio rejected the page:", res.status, res.error);
  return res.ok;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
