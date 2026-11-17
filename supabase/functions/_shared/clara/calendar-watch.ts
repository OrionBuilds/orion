/**
 * Calendar watchers (ported from CLARA's meeting-prep and conflict-scan jobs), on the Outlook mirror.
 *
 *  - meeting prep: ~75 minutes before an event whose attendees include a known client, ONE briefing to
 *    the owner (who they are, their projects, what shipped, open asks, what's pending), deduped per
 *    event. Owner-facing only: nothing here is ever sent to a client.
 *  - conflict scan: two busy events that overlap in the next 48h are flagged once.
 * Both are deterministic (no model): the facts are all in the OS and a wrong "fact" in a pre-meeting
 * note is worse than a plain one.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import type { NotifyRequest } from "./notify.ts";

export const PREP_LEAD_MIN = 75;

interface Ev { id: string; graph_event_id: string; title: string | null; start_time: string; end_time: string; status: string; transparency: string; attendees: { email?: string; name?: string }[] | null; organizer_email: string | null }

const tzFmt = (iso: string, tz: string) => new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" });

/** Pure: do two events overlap in time (touching end/start is not a conflict)? */
export const overlaps = (a: Pick<Ev, "start_time" | "end_time">, b: Pick<Ev, "start_time" | "end_time">) =>
  Date.parse(a.start_time) < Date.parse(b.end_time) && Date.parse(b.start_time) < Date.parse(a.end_time);

export async function scanConflicts(db: SupabaseClient, env: Env, d: { userId: string; now: Date; notify: (r: NotifyRequest) => Promise<unknown> }): Promise<number> {
  const tz = env.get("CLARA_TZ") || "America/New_York";
  const { data } = await db.from("microsoft_calendar_events").select("id, graph_event_id, title, start_time, end_time, status, transparency, attendees, organizer_email")
    .eq("user_id", d.userId).gte("end_time", d.now.toISOString()).lte("start_time", new Date(d.now.getTime() + 48 * 3_600_000).toISOString()).order("start_time").limit(80);
  const evs = ((data ?? []) as Ev[]).filter((e) => e.status !== "cancelled" && e.transparency !== "transparent");
  let flagged = 0;
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      if (Date.parse(evs[j].start_time) >= Date.parse(evs[i].end_time)) break; // sorted by start: nothing later can overlap i
      if (!overlaps(evs[i], evs[j])) continue;
      await d.notify({
        kind: "calendar.conflict", priority: "normal",
        text: `Calendar conflict: "${evs[i].title ?? "busy"}" (${tzFmt(evs[i].start_time, tz)}) overlaps "${evs[j].title ?? "busy"}" (${tzFmt(evs[j].start_time, tz)}).`,
        dedupeKey: `conflict:${[evs[i].graph_event_id, evs[j].graph_event_id].sort().join(":")}`,
      });
      flagged++;
    }
  }
  return flagged;
}

export async function prepMeetings(
  db: SupabaseClient, env: Env, d: { orgId: string; userId: string; now: Date; ownerEmails: string[]; notify: (r: NotifyRequest) => Promise<unknown> },
): Promise<{ prepared: number }> {
  const tz = env.get("CLARA_TZ") || "America/New_York";
  const from = new Date(d.now.getTime());
  const to = new Date(d.now.getTime() + PREP_LEAD_MIN * 60_000);
  const { data } = await db.from("microsoft_calendar_events").select("id, graph_event_id, title, start_time, end_time, status, transparency, attendees, organizer_email")
    .eq("user_id", d.userId).gte("start_time", from.toISOString()).lte("start_time", to.toISOString()).order("start_time").limit(10);
  let prepared = 0;
  for (const e of ((data ?? []) as Ev[]).filter((x) => x.status !== "cancelled")) {
    const emails = [...new Set((e.attendees ?? []).map((a) => (a.email ?? "").toLowerCase()).filter((x) => x && !d.ownerEmails.includes(x)))];
    const clients: { id: string; name: string; company: string | null }[] = [];
    for (const em of emails) {
      const { data: c } = await db.from("contacts").select("id, first_name, last_name, company").eq("organization_id", d.orgId).eq("status", "active").ilike("email", em).maybeSingle();
      const k = c as { id: string; first_name: string | null; last_name: string | null; company: string | null } | null;
      if (k) clients.push({ id: k.id, name: `${k.first_name ?? ""} ${k.last_name ?? ""}`.trim() || em, company: k.company });
    }
    if (!clients.length) continue;
    const lines: string[] = [`${e.title ?? "Meeting"} at ${tzFmt(e.start_time, tz)}`];
    for (const c of clients) {
      lines.push(`\n${c.name}${c.company ? ` (${c.company})` : ""}`);
      const { data: projs } = await db.from("projects").select("id, name, status").eq("contact_id", c.id).limit(5);
      for (const p of (projs ?? []) as { id: string; name: string; status: string }[]) {
        const { data: ts } = await db.from("project_tasks").select("title, status").eq("project_id", p.id).order("updated_at", { ascending: false }).limit(4);
        const open = ((ts ?? []) as { title: string; status: string }[]).filter((t) => t.status !== "completed" && t.status !== "cancelled").map((t) => t.title);
        const doneRecently = ((ts ?? []) as { title: string; status: string }[]).filter((t) => t.status === "completed").map((t) => t.title);
        lines.push(`- ${p.name} (${p.status})${doneRecently.length ? `; recently done: ${doneRecently.slice(0, 2).join(", ")}` : ""}${open.length ? `; open: ${open.slice(0, 3).join(", ")}` : ""}`);
      }
      const { data: last } = await db.from("messages").select("channel, direction, subject, body, sent_at").eq("contact_id", c.id).order("sent_at", { ascending: false }).limit(3);
      for (const m of (last ?? []) as { channel: string; direction: string; subject: string | null; body: string; sent_at: string }[]) {
        lines.push(`- ${m.direction === "inbound" ? "they wrote" : "we wrote"} (${m.channel}, ${tzFmt(m.sent_at, tz)}): ${(m.subject ? m.subject + " — " : "") + m.body.replace(/\s+/g, " ").slice(0, 110)}`);
      }
      const { data: fb } = await db.from("contact_timeline").select("event_data").eq("contact_id", c.id).eq("event_type", "feedback").order("created_at", { ascending: false }).limit(1);
      const score = (fb as { event_data: { score?: number } }[] | null)?.[0]?.event_data?.score;
      if (score !== undefined) lines.push(`- last feedback: ${score}/5`);
    }
    await d.notify({ kind: "meeting.prep", priority: "normal", text: lines.join("\n"), dedupeKey: `prep:${e.graph_event_id}` });
    prepared++;
  }
  return { prepared };
}
