/**
 * Clara's briefs: what the owner needs to know and decide, from OS data (replaces CLARA's vault/ledger
 * composition, which is gone). Gathering is deterministic and failure-isolated (one broken query never
 * kills the brief); the model only phrases it, and if the model is down a plain template is sent
 * instead, so the owner never wakes up to no brief.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { names } from "./persona.ts";
import { listPending } from "./approvals.ts";
import { markDigested, pendingForDigest } from "./notify.ts";
import { ANTHROPIC_API_VERSION, CLARA_MODEL, getAnthropicMessagesUrl } from "../claraConfig.ts";
import { meteredFetch } from "../ai-usage.ts";

export type BriefKind = "morning" | "evening" | "weekly";

/** Pure: which brief is due in this local hour? Morning 08, evening 20, weekly Friday 16. */
export function briefDue(now: Date, tz: string): { kind: BriefKind; localDate: string } | null {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const hour = Number(g("hour")) % 24;
  const localDate = `${g("year")}-${g("month")}-${g("day")}`;
  if (hour === 8) return { kind: "morning", localDate };
  if (hour === 16 && g("weekday") === "Fri") return { kind: "weekly", localDate };
  if (hour === 20) return { kind: "evening", localDate };
  return null;
}

export interface BriefData {
  kind: BriefKind;
  agenda: { when: string; title: string }[];
  approvals: { title: string; agent: string | null }[];
  held: { id: string; kind: string; text: string }[];
  fridayOpen: string[];
  fridayDone: string[];
  inbound: { email: number; sms: number; voice: number; people: string[] };
  missedOrUnhandledCalls: number;
  appointments: { when: string; who: string }[];
  ownerTasks: { title: string; due: string }[];
  lowFeedback: string[];
  completedTasks: number;
}

const safe = async <T>(p: PromiseLike<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
const tzFmt = (iso: string, tz: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });

export async function gatherBriefData(db: SupabaseClient, env: Env, orgId: string, kind: BriefKind, now: Date): Promise<BriefData> {
  const tz = env.get("CLARA_TZ") || "America/New_York";
  const spanH = kind === "weekly" ? 24 * 7 : 24;
  const since = new Date(now.getTime() - spanH * 3_600_000).toISOString();
  // Morning looks at today, evening and weekly at what's next.
  const aheadFrom = now;
  const aheadTo = new Date(now.getTime() + (kind === "weekly" ? 72 : 30) * 3_600_000);
  const calUser = env.get("CLARA_CALENDAR_USER_ID")?.trim() || env.get("CLARA_USER_ID")?.trim();
  const claraId = env.get("CLARA_USER_ID")?.trim();
  const ownerId = env.get("OWNER_USER_ID")?.trim();

  const [agenda, approvals, held, reqs, msgs, calls, appts, tasks, fb, done] = await Promise.all([
    safe((async () => {
      if (!calUser) return [];
      const { data } = await db.from("microsoft_calendar_events").select("title, start_time, status").eq("user_id", calUser)
        .gte("end_time", aheadFrom.toISOString()).lte("start_time", aheadTo.toISOString()).order("start_time").limit(15);
      return ((data ?? []) as { title: string | null; start_time: string; status: string }[]).filter((e) => e.status !== "cancelled").map((e) => ({ when: tzFmt(e.start_time, tz), title: e.title ?? "(busy)" }));
    })(), [] as BriefData["agenda"]),
    safe(listPending(db, orgId, 10), []),
    safe(pendingForDigest(db, orgId, 30), []),
    safe((async () => {
      if (!claraId) return [] as { title: string; status: string; result_summary: string | null }[];
      const { data } = await db.from("agent_requests").select("title, status, result_summary, updated_at").eq("org_id", orgId).eq("from_user_id", claraId).gte("updated_at", since).order("updated_at", { ascending: false }).limit(15);
      return (data ?? []) as { title: string; status: string; result_summary: string | null }[];
    })(), [] as { title: string; status: string; result_summary: string | null }[]),
    safe((async () => {
      const { data } = await db.from("messages").select("channel, contact_id").eq("organization_id", orgId).eq("direction", "inbound").gte("sent_at", since).limit(200);
      return (data ?? []) as { channel: string; contact_id: string }[];
    })(), [] as { channel: string; contact_id: string }[]),
    safe((async () => {
      const { data } = await db.from("call_logs").select("status, direction, duration").eq("organization_id", orgId).eq("direction", "inbound").gte("created_at", since).limit(100);
      return (data ?? []) as { status: string; duration: number }[];
    })(), [] as { status: string; duration: number }[]),
    safe((async () => {
      const { data } = await db.from("appointments").select("start_at_utc, contact_id, status").eq("org_id", orgId).eq("status", "scheduled")
        .gte("start_at_utc", aheadFrom.toISOString()).lte("start_at_utc", aheadTo.toISOString()).order("start_at_utc").limit(10);
      const rows = (data ?? []) as { start_at_utc: string; contact_id: string | null }[];
      const out: BriefData["appointments"] = [];
      for (const a of rows) {
        const { data: c } = a.contact_id ? await db.from("contacts").select("first_name, last_name, company").eq("id", a.contact_id).maybeSingle() : { data: null };
        const k = c as { first_name: string | null; last_name: string | null; company: string | null } | null;
        out.push({ when: tzFmt(a.start_at_utc, tz), who: k ? `${k.first_name ?? ""} ${k.last_name ?? ""}`.trim() || k.company || "someone" : "someone" });
      }
      return out;
    })(), [] as BriefData["appointments"]),
    safe((async () => {
      if (!ownerId) return [] as { title: string; due_at_utc: string }[];
      const { data } = await db.from("calendar_tasks").select("title, due_at_utc, status").eq("org_id", orgId).eq("user_id", ownerId).neq("status", "completed")
        .lte("due_at_utc", new Date(now.getTime() + 36 * 3_600_000).toISOString()).order("due_at_utc").limit(10);
      return (data ?? []) as { title: string; due_at_utc: string }[];
    })(), [] as { title: string; due_at_utc: string }[]),
    safe((async () => {
      const { data } = await db.from("contact_timeline").select("event_data, created_at").eq("event_type", "feedback").gte("created_at", since).limit(20);
      return ((data ?? []) as { event_data: { score?: number; text?: string } }[]).filter((r) => (r.event_data?.score ?? 5) <= 3).map((r) => `${r.event_data.score}/5${r.event_data.text ? `: ${r.event_data.text.slice(0, 80)}` : ""}`);
    })(), [] as string[]),
    safe((async () => {
      if (kind !== "weekly") return 0;
      const { count } = await db.from("project_tasks").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "completed").gte("completed_at", since);
      return count ?? 0;
    })(), 0),
  ]);

  const contactIds = [...new Set(msgs.map((m) => m.contact_id))].slice(0, 6);
  const people: string[] = [];
  for (const id of contactIds) {
    const c = await safe((async () => {
      const { data } = await db.from("contacts").select("first_name, last_name, company").eq("id", id).maybeSingle();
      return data as { first_name: string | null; last_name: string | null; company: string | null } | null;
    })(), null);
    if (c) people.push(`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.company || "someone");
  }
  const count = (ch: string) => msgs.filter((m) => m.channel === ch).length;
  return {
    kind, agenda, approvals: approvals.map((a) => ({ title: a.title, agent: a.agent_slug })),
    held: held.map((h) => ({ id: h.id, kind: h.kind, text: h.text })),
    fridayOpen: reqs.filter((r) => r.status === "queued" || r.status === "claimed").map((r) => r.title),
    fridayDone: reqs.filter((r) => r.status === "completed" || r.status === "failed" || r.status === "needs_input").map((r) => `${r.title} — ${r.status}${r.result_summary ? `: ${r.result_summary.slice(0, 100)}` : ""}`),
    inbound: { email: count("email"), sms: count("sms"), voice: count("voice"), people },
    missedOrUnhandledCalls: calls.filter((c) => c.status === "no-answer" || c.status === "busy" || c.status === "failed").length,
    appointments: appts, ownerTasks: tasks.map((t) => ({ title: t.title, due: tzFmt(t.due_at_utc, tz) })), lowFeedback: fb, completedTasks: done,
  };
}

const TITLES: Record<BriefKind, string> = { morning: "Good morning", evening: "Evening wrap", weekly: "Weekly review" };

/** The brief with no model: plain, complete, and good enough to act on. */
export function templateBrief(env: Env, d: BriefData): { subject: string; body: string } {
  const n = names(env);
  const sec = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.map((l) => `- ${l}`).join("\n")}\n` : "");
  const body = [
    `${TITLES[d.kind]}, ${n.ownerFirst}.\n`,
    sec("Needs your decision", d.approvals.map((a) => `${a.title}${a.agent ? ` (${a.agent})` : ""}`)),
    sec(d.kind === "morning" ? "Today" : "Coming up", [...d.agenda.map((e) => `${e.when}: ${e.title}`), ...d.appointments.map((a) => `${a.when}: appointment with ${a.who}`)]),
    sec("Your tasks", d.ownerTasks.map((t) => `${t.title} (due ${t.due})`)),
    sec("FRIDAY", [...d.fridayOpen.map((t) => `working: ${t}`), ...d.fridayDone]),
    sec("Clients", [
      d.inbound.email + d.inbound.sms + d.inbound.voice > 0 ? `${d.inbound.email} emails, ${d.inbound.sms} texts, ${d.inbound.voice} call events${d.inbound.people.length ? ` (${d.inbound.people.join(", ")})` : ""}` : "",
      d.missedOrUnhandledCalls ? `${d.missedOrUnhandledCalls} calls that were not answered` : "", ...d.lowFeedback.map((f) => `low feedback score ${f}`),
    ].filter(Boolean)),
    sec("Also", [...d.held.map((h) => h.text.split("\n")[0].slice(0, 160)), ...(d.kind === "weekly" && d.completedTasks ? [`${d.completedTasks} project tasks completed this week`] : [])]),
  ].filter(Boolean).join("\n").trim();
  return { subject: `${TITLES[d.kind]} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, body: body.length > 40 ? body : `${body}\n\nNothing needs you right now.` };
}

/** Model phrasing of the same facts. Null on any failure; never invents data beyond what's passed. */
export async function modelBrief(env: Env, d: BriefData, f: typeof fetch = meteredFetch({ source: "clara-briefs", agent: "clara", purpose: "brief" })): Promise<{ subject: string; body: string } | null> {
  const key = env.get("ANTHROPIC_API_KEY")?.trim();
  if (!key) return null;
  const n = names(env);
  try {
    const r = await f(getAnthropicMessagesUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_API_VERSION },
      body: JSON.stringify({
        model: env.get("CLARA_BRIEF_MODEL")?.trim() || CLARA_MODEL, max_tokens: 900,
        system: `You are Clara, ${n.ownerName}'s executive assistant. Write his ${d.kind} brief from the JSON facts only. Lead with what needs his decision. Short sections, plain text, no markdown headers, no emoji, no filler. Say nothing that is not in the facts; if a section is empty, omit it. Dry, warm, brief. Sign "— Clara".`,
        messages: [{ role: "user", content: JSON.stringify(d) }],
        output_config: { format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } } } },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) { console.warn("[brief] model call failed:", r.status, (await r.text().catch(() => "")).slice(0, 300)); return null; }
    const j = await r.json() as { content?: { type: string; text?: string }[] };
    const m = (j.content?.find((b) => b.type === "text")?.text ?? "").match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]) as { subject?: string; body?: string } : null;
    return out?.subject && out.body && out.body.length > 40 ? { subject: out.subject.slice(0, 150), body: out.body } : null;
  } catch { return null; }
}

export async function runBrief(
  db: SupabaseClient, env: Env, i: { orgId: string; now: Date; due: { kind: BriefKind; localDate: string }; send: (subject: string, body: string) => Promise<void>; model?: typeof modelBrief },
): Promise<"sent" | "already" | "failed"> {
  const { data: existing } = await db.from("clara_briefs").select("id, delivered_at").eq("organization_id", i.orgId).eq("kind", i.due.kind).eq("local_date", i.due.localDate).maybeSingle();
  const ex = existing as { id: string; delivered_at: string | null } | null;
  if (ex?.delivered_at) return "already";

  const data = await gatherBriefData(db, env, i.orgId, i.due.kind, i.now);
  const modeled = await (i.model ?? modelBrief)(env, data).catch(() => null);
  const brief = modeled ?? templateBrief(env, data);
  let id = ex?.id;
  if (!id) {
    const { data: row, error } = await db.from("clara_briefs").insert({ organization_id: i.orgId, kind: i.due.kind, local_date: i.due.localDate, subject: brief.subject, body: brief.body, composed_by: modeled ? "model" : "template" }).select("id").maybeSingle();
    if (error) { if (error.code === "23505") return "already"; return "failed"; }
    id = (row as { id: string } | null)?.id;
  }
  try {
    await i.send(brief.subject, brief.body);
  } catch (e) {
    console.error("[brief] send failed:", e);
    return "failed"; // row stays undelivered: the next hourly pass retries within the hour window
  }
  await db.from("clara_briefs").update({ delivered_at: i.now.toISOString() }).eq("id", id!);
  await markDigested(db, data.held.map((h) => h.id), i.now); // only what the brief actually carried
  return "sent";
}
