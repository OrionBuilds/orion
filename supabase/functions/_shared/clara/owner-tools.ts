/**
 * What Clara can actually DO when the owner asks (text or voice).
 *
 * Every tool performs the real action and returns an honest result line. Nothing here "acknowledges"
 * work it hasn't done: a tool either did the thing and says so, failed and says so, or needs one
 * clarifying answer. The reply to the owner is built from these lines (owner-brain.ts), never from
 * the model's own claims. That is the structural fix for CLARA's old failure ("Inbox swept" having
 * swept nothing).
 *
 * Authority: these tools are reachable ONLY by the verified owner: his number (owner-sms / voice
 * owner path) or, in the app, the org owner / SuperAdmin (agent-thread, clara-chat). Content from
 * anyone else never gets here, so text inside a client's email cannot make Clara send or delegate
 * anything. Owner asks run without approval (money excepted: there is no payment tool). Tools
 * marked ownerOnly additionally refuse unless ctx.ownerVerified is set (runTool).
 *
 * The read tools (find, client_overview, project_work, agents_status, mailbox_status, …) live in
 * owner-read-tools.ts.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { normalizeE164 } from "./phones.ts";
import { findOrCreateConversation, insertMessage } from "./conversations.ts";
import { decide, listPending } from "./approvals.ts";
import { type Person, searchContacts } from "./contacts-search.ts";
import type { MailboxSnapshot } from "./mailbox.ts";
import { READ_TOOLS, resolveSubject } from "./owner-read-tools.ts";
import { MANAGE_TOOLS } from "./owner-manage-tools.ts";
import { personalCalendarId, resolveUser } from "./owner-helpers.ts";
import { FACTORY_TOOLS } from "./factory-tools.ts";
import { CAIO_TOOLS } from "./caio-tools.ts";
import { WAITING_COLUMNS, type WaitingRequest, fridayUserId, requeueWithAnswer } from "./friday-requests.ts";

export { type Person, personalCalendarId, searchContacts };

export interface OwnerCtx {
  db: SupabaseClient;
  env: Env;
  orgId: string;
  ownerUserId: string | null;
  claraUserId: string | null;
  /** Clara's number the owner is talking to (outbound texts leave from it). */
  claraNumber: string;
  channel: "sms" | "voice" | "chat";
  /**
   * The turn comes from the verified owner (his number, or the org owner / SuperAdmin in the app).
   * ownerOnly tools refuse without it. Set explicitly by each entry point; never inferred.
   */
  ownerVerified: boolean;
  now: () => Date;
  // Seams to the outside world (real implementations live in runtime.ts).
  sendSms: (from: string, to: string, body: string) => Promise<boolean>;
  sendEmail: (m: { to: string[]; subject: string; body: string }) => Promise<void>;
  createEvent: (e: { subject: string; startISO: string; endISO: string; attendees: string[]; body?: string }) => Promise<{ id: string }>;
  /** Live read of a user's connected mailbox (null = none connected). Absent where mail can't be read. */
  readMailbox?: (userId: string, o: { top: number; query?: string }) => Promise<MailboxSnapshot | null>;
  /**
   * Cancel or move an OS booking through the booking API, as the host: the guest is emailed and
   * the calendar event follows. Absent where bookings can't be changed.
   */
  changeBooking?: (b: { action: "cancel"; token: string; reason?: string } | { action: "reschedule"; token: string; startISO: string; endISO: string }) => Promise<{ ok: boolean; error?: string }>;
}

export interface ToolResult {
  ok: boolean;
  /** One plain sentence stating what happened (or didn't). This is what the owner is told. */
  line: string;
  /** The tool needs one answer from the owner before it can act. */
  clarify?: boolean;
  /** Extra detail for read tools (kept out of the spoken headline). */
  detail?: string;
}

export interface OwnerTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Read-only tools can't change anything; the brain may speak their detail. */
  readOnly?: boolean;
  /** Only for the verified owner (business data, mail, money). See runTool. */
  ownerOnly?: boolean;
  run: (c: OwnerCtx, args: Record<string, unknown>) => Promise<ToolResult>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

// ── Resolving "Jackson" to a person (searchContacts lives in contacts-search.ts) ─────────────

type Resolved = { person?: Person; address?: string; clarify?: string };

/** Who does "who" mean? A raw email/number is taken as-is; a name must match exactly one contact. */
export async function resolveRecipient(c: OwnerCtx, who: string, want: "email" | "phone"): Promise<Resolved> {
  const w = who.trim();
  if (want === "email" && EMAIL_RE.test(w)) return { address: w.toLowerCase() };
  if (want === "phone" && normalizeE164(w)) {
    const { data } = await c.db.rpc("find_contact_id_by_phone", { p_org: c.orgId, p_phone: normalizeE164(w) });
    return { address: normalizeE164(w)!, person: data ? ({ id: data as string, name: w, email: null, phone: w, company: null }) : undefined };
  }
  const found = await searchContacts(c.db, c.orgId, w);
  const usable = found.filter((p) => (want === "email" ? p.email : p.phone));
  if (usable.length === 1) return { person: usable[0], address: want === "email" ? usable[0].email! : normalizeE164(usable[0].phone) ?? usable[0].phone! };
  if (usable.length === 0) {
    return { clarify: found.length
      ? `I found ${found[0].name} but there's no ${want === "email" ? "email address" : "phone number"} on file. What should I use?`
      : `I don't have a contact called "${w}". Give me their ${want === "email" ? "email" : "number"} and I'll use it.` };
  }
  return { clarify: `Which ${w} do you mean: ${usable.slice(0, 4).map((p) => `${p.name}${p.company ? ` (${p.company})` : ""}`).join(", ")}?` };
}

// ── Tools ───────────────────────────────────────────────────────────────────────────────────

const createTask: OwnerTool = {
  name: "create_task",
  description: "Create a task. It is assigned to the owner unless assignee names someone else on the team; it shows on that person's Tasks page. Plain reminders/to-dos go on the personal list; give project (name or id) to file it under that project, or contact (name) to file it on that client's record. due is an ISO 8601 date or datetime with offset. To have FRIDAY do work use delegate_to_friday instead: FRIDAY does not work from the task list.",
  input_schema: {
    type: "object", required: ["title"],
    properties: {
      title: { type: "string" }, details: { type: "string" },
      due: { type: "string", description: "ISO 8601; omit for tomorrow 5pm" },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      project: { type: "string", description: "Project name or id to file it under" },
      contact: { type: "string", description: "Client contact name to file it on" },
      assignee: { type: "string", description: "Team member's name; omit for the owner" },
    },
  },
  async run(c, a) {
    const title = str(a.title);
    if (!title) return { ok: false, clarify: true, line: "What should the task say?" };
    if (!c.ownerUserId) return { ok: false, line: "I couldn't create the task: the owner's OS user isn't configured (OWNER_USER_ID)." };
    const tz = c.env.get("CLARA_TZ") || "America/New_York";
    // A bare date ("2026-10-23") means that day, not UTC midnight (the evening before in the Americas).
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(str(a.due));
    let due = new Date(dateOnly ? `${str(a.due)}T21:00:00Z` : str(a.due));
    if (!str(a.due) || Number.isNaN(due.getTime())) {
      due = new Date(c.now().getTime() + 86_400_000);
      due.setUTCHours(21, 0, 0, 0); // ~5pm Eastern next day when no due date was given
    }
    const dueDate = dateOnly ? str(a.due) : due.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD in the owner's zone
    const priority = ["low", "medium", "high"].includes(str(a.priority)) ? str(a.priority) : "medium";
    const whenText = due.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    let assignee = c.ownerUserId, toWhom = "you";
    if (str(a.assignee)) {
      const u = await resolveUser(c, str(a.assignee));
      if ("clarify" in u) return { ok: false, clarify: true, line: u.clarify };
      // A task on FRIDAY's list would sit there unread: his work arrives as requests.
      if (u.user.id === await fridayUserId(c.db, c.env, c.orgId)) return { ok: false, line: "FRIDAY doesn't work from the task list, so I didn't create that. I can hand it to him as a request instead." };
      if (u.user.id !== c.ownerUserId) { assignee = u.user.id; toWhom = u.user.name; }
    }

    if (str(a.project)) {
      const p = str(a.project);
      let project: { id: string; name: string } | null = null;
      if (/^[0-9a-f-]{36}$/i.test(p)) {
        const { data } = await c.db.from("projects").select("id, name").eq("org_id", c.orgId).eq("id", p).maybeSingle();
        project = data as { id: string; name: string } | null;
      } else {
        const s = await resolveSubject(c, p, ["project"]);
        if (s.kind === "clarify") return { ok: false, clarify: true, line: s.line };
        if (s.kind === "project") project = { id: s.id, name: s.name };
      }
      if (!project) return { ok: false, clarify: true, line: `I can't find a project called "${p}". Which project, or should it go on your personal list?` };
      const { data, error } = await c.db.from("project_tasks").insert({
        org_id: c.orgId, project_id: project.id, title: title.slice(0, 300), description: str(a.details) || null, status: "todo", priority,
        due_date: dueDate, assigned_user_id: assignee, created_by: c.claraUserId,
      }).select("id").maybeSingle();
      if (error || !data) return { ok: false, line: `I couldn't create the task: ${error?.message ?? "no row returned"}.` };
      return { ok: true, line: `Task created on ${project.name}: "${title.slice(0, 80)}", assigned to ${toWhom}, due ${dueDate}.` };
    }

    if (str(a.contact)) {
      const people = await searchContacts(c.db, c.orgId, str(a.contact));
      if (people.length !== 1) {
        return { ok: false, clarify: true, line: people.length ? `Which ${str(a.contact)}: ${people.slice(0, 4).map((x) => `${x.name}${x.company ? ` (${x.company})` : ""}`).join(", ")}?` : `I don't have a contact called "${str(a.contact)}".` };
      }
      const { data, error } = await c.db.from("contact_tasks").insert({
        contact_id: people[0].id, title: title.slice(0, 300), description: str(a.details) || null, status: "pending", priority,
        due_date: due.toISOString(), assigned_to_user_id: assignee, created_by_user_id: c.claraUserId,
      }).select("id").maybeSingle();
      if (error || !data) return { ok: false, line: `I couldn't create the task: ${error?.message ?? "no row returned"}.` };
      return { ok: true, line: `Task created on ${people[0].name}'s record: "${title.slice(0, 80)}", assigned to ${toWhom}, due ${whenText}.` };
    }

    const cal = await personalCalendarId(c, assignee);
    if (!cal) return { ok: false, line: `I couldn't create the task: I couldn't find or set up ${toWhom === "you" ? "your" : `${toWhom}'s`} personal task list in the OS.` };
    const { data, error } = await c.db.from("calendar_tasks").insert({
      org_id: c.orgId, calendar_id: cal, user_id: assignee, title: title.slice(0, 300),
      description: str(a.details) || null, due_at_utc: due.toISOString(), priority, status: "pending", created_by: c.claraUserId,
    }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't create the task: ${error?.message ?? "no row returned"}.` };
    return { ok: true, line: `Task created${toWhom === "you" ? "" : ` for ${toWhom}`}: "${title.slice(0, 80)}", due ${whenText}.` };
  },
};

const sendEmail: OwnerTool = {
  name: "send_email",
  description: "Send an email from Clara's mailbox (the owner is CC'd automatically). Recipients may be email addresses or contact names. Write the full body yourself in Clara's voice, signed as Clara, assistant to the owner.",
  input_schema: {
    type: "object", required: ["to", "subject", "body"],
    properties: { to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, body: { type: "string" } },
  },
  async run(c, a) {
    const who = strs(a.to);
    if (!who.length || !str(a.subject) || !str(a.body)) return { ok: false, clarify: true, line: "I need a recipient, a subject and what to say." };
    const addrs: string[] = [];
    for (const w of who) {
      const r = await resolveRecipient(c, w, "email");
      if (r.clarify) return { ok: false, clarify: true, line: r.clarify };
      addrs.push(r.address!);
    }
    try {
      await c.sendEmail({ to: addrs, subject: str(a.subject).slice(0, 200), body: str(a.body) });
    } catch (e) {
      return { ok: false, line: `I couldn't send that email: ${String((e as Error).message).slice(0, 140)}. Nothing was sent.` };
    }
    return { ok: true, line: `Emailed ${addrs.join(", ")} — "${str(a.subject).slice(0, 60)}". You're CC'd.` };
  },
};

const sendText: OwnerTool = {
  name: "send_text",
  description: "Send an SMS from Clara's number to a contact (name or phone number) and log it in their conversation. Keep it short, sign as Clara, assistant to the owner. Never to anyone who opted out.",
  input_schema: {
    type: "object", required: ["to", "body"],
    properties: { to: { type: "string" }, body: { type: "string" } },
  },
  async run(c, a) {
    const who = str(a.to), body = str(a.body);
    if (!who || !body) return { ok: false, clarify: true, line: "I need who to text and what to say." };
    const r = await resolveRecipient(c, who, "phone");
    if (r.clarify) return { ok: false, clarify: true, line: r.clarify };
    const to = r.address!;
    const { data: dnc } = await c.db.from("dnc_numbers").select("id").eq("org_id", c.orgId).eq("phone_number", to).maybeSingle();
    if (dnc) return { ok: false, line: `I didn't text ${r.person?.name ?? to}: they've opted out of texts.` };
    const sent = await c.sendSms(c.claraNumber, to, body.slice(0, 1500)).catch(() => false);
    if (!sent) return { ok: false, line: `I couldn't send that text to ${r.person?.name ?? to}. Nothing was sent.` };
    if (r.person?.id) {
      const conv = await findOrCreateConversation(c.db, { orgId: c.orgId, contactId: r.person.id, channel: "sms", assignedUserId: c.claraUserId });
      await insertMessage(c.db, {
        orgId: c.orgId, conversationId: conv.id, contactId: r.person.id, channel: "sms", direction: "outbound", body,
        messageType: "text", senderName: "Clara", senderIdentifier: c.claraNumber, metadata: { source: "owner_request", to_number: to },
      }).catch((e) => console.error("[owner-tools] text sent but not logged:", e));
    }
    return { ok: true, line: `Texted ${r.person?.name ?? to}.` };
  },
};

const delegate: OwnerTool = {
  name: "delegate_to_friday",
  description: "Hand work to FRIDAY. Two uses. (1) Engineering: code changes, bug fixes, bug reproduction/testing, QA, technical research. (2) kind task: any change inside the OS that none of your own tools covers (FRIDAY can drive every OS module: invoices and proposals as drafts, pipelines, forms, automations, settings, bulk edits, his Google/Outlook calendar events...). Never use it to pay, charge, refund or spend. Write a complete brief (what, where, exact names and values, what done looks like). The work is QUEUED, not done; FRIDAY picks it up within a minute or two and Clara reports the outcome to the owner when it finishes.",
  input_schema: {
    type: "object", required: ["kind", "title", "details"],
    properties: {
      kind: { type: "string", enum: ["code", "bug", "qa", "research", "content", "task", "other"] },
      title: { type: "string" }, details: { type: "string" },
    },
  },
  async run(c, a) {
    const title = str(a.title), details = str(a.details);
    if (!title || !details) return { ok: false, clarify: true, line: "What exactly should FRIDAY do?" };
    if (!c.claraUserId) return { ok: false, line: "I couldn't queue that: Clara's OS user isn't configured (CLARA_USER_ID)." };
    const friday = await fridayUserId(c.db, c.env, c.orgId);
    if (!friday) return { ok: false, line: "I couldn't queue that: I can't find FRIDAY's account in the OS." };
    const kind = ["code", "bug", "qa", "research", "content", "task", "other"].includes(str(a.kind)) ? str(a.kind) : "task";
    const { data, error } = await c.db.from("agent_requests").insert({
      org_id: c.orgId, from_user_id: c.claraUserId, to_user_id: friday, kind, title: title.slice(0, 300), body: details,
      source: { channel: c.channel, requested_by: "owner" },
    }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't queue that for FRIDAY: ${error?.message ?? "no row returned"}.` };
    return { ok: true, line: `Queued for FRIDAY (${kind}): "${title.slice(0, 80)}". I'll tell you when it's done.` };
  },
};

const findContact: OwnerTool = {
  name: "find_contact",
  readOnly: true, ownerOnly: true,
  description: "Look up a person or company in the CRM by name, company, or email. Read-only.",
  input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  async run(c, a) {
    const people = await searchContacts(c.db, c.orgId, str(a.query));
    if (!people.length) return { ok: true, line: `No contact matching "${str(a.query)}".` };
    return { ok: true, line: people.length === 1 ? `${people[0].name}${people[0].company ? `, ${people[0].company}` : ""}.` : `${people.length} matches, starting with ${people[0].name}.`,
      detail: people.map((p) => `${p.name}${p.company ? ` (${p.company})` : ""} ${p.phone ?? ""} ${p.email ?? ""}`.trim()).join("\n") };
  },
};

const createEvent: OwnerTool = {
  name: "create_event",
  description: "Put an event on the calendar. start and end are ISO 8601 with a UTC offset; end defaults to 30 minutes after start. Attendees (emails) are invited.",
  input_schema: {
    type: "object", required: ["subject", "start"],
    properties: { subject: { type: "string" }, start: { type: "string" }, end: { type: "string" }, attendees: { type: "array", items: { type: "string" } }, details: { type: "string" } },
  },
  async run(c, a) {
    const start = new Date(str(a.start));
    if (Number.isNaN(start.getTime())) return { ok: false, clarify: true, line: "What day and time should I put it on?" };
    if (start.getTime() < c.now().getTime() - 60_000) return { ok: false, clarify: true, line: "That time is in the past. When did you mean?" };
    const end = str(a.end) && !Number.isNaN(new Date(str(a.end)).getTime()) ? new Date(str(a.end)) : new Date(start.getTime() + 30 * 60_000);
    const attendees = strs(a.attendees).filter((x) => EMAIL_RE.test(x));
    try {
      await c.createEvent({ subject: str(a.subject).slice(0, 200), startISO: start.toISOString(), endISO: end.toISOString(), attendees, body: str(a.details) || undefined });
    } catch (e) {
      return { ok: false, line: `I couldn't create the event: ${String((e as Error).message).slice(0, 140)}.` };
    }
    const when = start.toLocaleString("en-US", { timeZone: c.env.get("CLARA_TZ") || "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return { ok: true, line: `On the calendar: "${str(a.subject).slice(0, 60)}", ${when}${attendees.length ? `, invited ${attendees.length}` : ""}.` };
  },
};

const answerFriday: OwnerTool = {
  name: "answer_friday",
  description: "Pass the owner's answer back to FRIDAY on a request where FRIDAY asked a question (status needs_input), whoever sent the request. FRIDAY gets a NEW follow-up request carrying the original brief, its question and the answer; the old one is closed.",
  input_schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, title_contains: { type: "string", description: "Disambiguate when several are waiting" } } },
  async run(c, a) {
    const msg = str(a.message);
    if (!msg) return { ok: false, clarify: true, line: "What should I tell FRIDAY?" };
    const friday = await fridayUserId(c.db, c.env, c.orgId);
    if (!friday) return { ok: false, line: "I couldn't pass that on: I can't find FRIDAY's account in the OS." };
    const { data } = await c.db.from("agent_requests").select(WAITING_COLUMNS)
      .eq("org_id", c.orgId).eq("to_user_id", friday).eq("status", "needs_input").order("finished_at", { ascending: false }).limit(5);
    let open = (data ?? []) as WaitingRequest[];
    const hint = str(a.title_contains).toLowerCase();
    if (hint) open = open.filter((r) => r.title.toLowerCase().includes(hint));
    if (open.length === 0) return { ok: false, line: "FRIDAY isn't waiting on an answer from you right now." };
    if (open.length > 1) return { ok: false, clarify: true, line: `FRIDAY is waiting on more than one thing: ${open.map((r) => `"${r.title.slice(0, 50)}"`).join(", ")}. Which one is this for?` };
    const r = open[0];
    const res = await requeueWithAnswer(c.db, r, msg, { now: c.now() });
    if (!res.ok) {
      return { ok: false, line: res.reason === "already_answered" ? `FRIDAY already has an answer on "${r.title.slice(0, 60)}".` : `I couldn't pass that to FRIDAY: ${res.error}.` };
    }
    return { ok: true, line: `Passed your answer to FRIDAY on "${r.title.slice(0, 60)}"; it's queued as a follow-up.` };
  },
};

const callPerson: OwnerTool = {
  name: "call_person",
  description: "Have Clara phone someone: a client or lead (to confirm, follow up, clarify) or a business the owner asks her to call (a booking, a reservation). Give the person or business by contact name or phone number, what the call is for, and the specific facts she must come back with. The call is QUEUED and placed within a couple of minutes, inside calling hours; the owner is told how it went. Never use this to cold-call anyone.",
  input_schema: {
    type: "object", required: ["who", "goal"],
    properties: {
      who: { type: "string", description: "Contact name or phone number" },
      business_name: { type: "string", description: "Name to use if calling a number that is not in the CRM" },
      goal: { type: "string", description: "What Clara says the call is about, spoken style, e.g. 'I'd like to book a table for four on Friday at 7pm.'" },
      must_confirm: { type: "array", items: { type: "string" } },
      not_before: { type: "string", description: "ISO 8601 with offset; omit to call as soon as possible" },
    },
  },
  async run(c, a) {
    const goal = str(a.goal), who = str(a.who);
    if (!who || !goal) return { ok: false, clarify: true, line: "Who should I call, and what is it about?" };
    const r = await resolveRecipient(c, who, "phone");
    if (r.clarify) return { ok: false, clarify: true, line: r.clarify };
    const name = r.person?.name && r.person.name !== r.address ? r.person.name : str(a.business_name) || who;
    const nb = new Date(str(a.not_before));
    const notBefore = str(a.not_before) && !Number.isNaN(nb.getTime()) ? nb : c.now();
    const { data, error } = await c.db.from("clara_call_requests").insert({
      organization_id: c.orgId, requested_by: "owner", kind: "owner_request", contact_id: r.person?.id ?? null, name: name.slice(0, 120),
      phone_e164: r.address, goal: goal.slice(0, 1000), must_confirm: strs(a.must_confirm).slice(0, 6), not_before: notBefore.toISOString(),
    }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't queue that call: ${error?.message ?? "no row returned"}.` };
    const later = notBefore.getTime() > c.now().getTime() + 5 * 60_000;
    return { ok: true, line: later
      ? `Call to ${name} queued for ${notBefore.toLocaleString("en-US", { timeZone: c.env.get("CLARA_TZ") || "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })}. I'll tell you how it goes.`
      : `Call to ${name} queued; it goes out within a couple of minutes (calling hours permitting). I'll tell you how it goes.` };
  },
};

const listApprovals: OwnerTool = {
  name: "list_approvals",
  readOnly: true, ownerOnly: true,
  description: "List what is waiting for the owner's approval (drafts from Clara, FRIDAY and the workflow engine). Read-only.",
  input_schema: { type: "object", properties: {} },
  async run(c) {
    const rows = await listPending(c.db, c.orgId);
    if (!rows.length) return { ok: true, line: "Nothing is waiting for your approval." };
    return { ok: true, line: `${rows.length} waiting for your approval.`, detail: rows.map((r, i) => `${i + 1}. ${r.title}${r.agent_slug ? ` (${r.agent_slug})` : ""}${r.description ? ` — ${r.description.replace(/\s+/g, " ").slice(0, 120)}` : ""}`).join("\n") };
  },
};

const decideApproval: OwnerTool = {
  name: "decide_approval",
  description: "Approve or reject ONE pending approval for the owner, when he says so (\"approve the Pat email\", \"reject the second one\"). Identify it by words from its title or its position in the list. Approving a draft releases it to be sent; rejecting discards it. If more than one item could match, ask which.",
  input_schema: {
    type: "object", required: ["decision"],
    properties: { decision: { type: "string", enum: ["approve", "reject"] }, match: { type: "string", description: "Words from the title, or a number from the list" }, comment: { type: "string" } },
  },
  async run(c, a) {
    const decision = str(a.decision) === "reject" ? "reject" as const : str(a.decision) === "approve" ? "approve" as const : null;
    if (!decision) return { ok: false, clarify: true, line: "Approve it or reject it?" };
    if (!c.ownerUserId) return { ok: false, line: "I couldn't record that: the owner's OS user isn't configured (OWNER_USER_ID)." };
    const pending = await listPending(c.db, c.orgId);
    if (!pending.length) return { ok: false, line: "Nothing is waiting for your approval." };
    const m = str(a.match).toLowerCase();
    let pick = pending;
    if (/^\d+$/.test(m)) {
      // A bare number is either a PR number from a merge-approval title ("…#123…") — the owner's
      // "approve 123" for a ready FRIDAY PR — or a position in the list. Prefer a unique PR-number
      // match (the #123 negative-lookahead stops "#123" from also matching "#1234"); else position.
      const byPr = pending.filter((p) => new RegExp(`#${m}(?!\\d)`).test(`${p.title} ${p.description ?? ""}`));
      pick = byPr.length === 1 ? byPr : pending.slice(Number(m) - 1, Number(m));
    } else if (m) pick = pending.filter((p) => `${p.title} ${p.description ?? ""}`.toLowerCase().includes(m));
    else if (pending.length > 1) pick = [];
    if (pick.length !== 1) {
      return { ok: false, clarify: true, line: pick.length === 0 && m ? `Nothing waiting matches "${m}". ${pending.length} are waiting: ${pending.slice(0, 4).map((p, i) => `${i + 1}. ${p.title}`).join("; ")}.` : `Which one? ${pending.slice(0, 4).map((p, i) => `${i + 1}. ${p.title}`).join("; ")}.` };
    }
    try {
      const r = await decide(c.db, { approvalId: pick[0].id, decision, ownerUserId: c.ownerUserId, ownerEmail: c.env.get("OWNER_CC_EMAIL") ?? null, comment: str(a.comment) || undefined });
      return { ok: true, line: decision === "approve" ? `Approved: "${pick[0].title.slice(0, 80)}" (${r.status}). It goes out within a minute.` : `Rejected: "${pick[0].title.slice(0, 80)}" (${r.status}). Nothing will be sent.` };
    } catch (e) {
      return { ok: false, line: `I couldn't record that decision: ${String((e as Error).message).slice(0, 140)}.` };
    }
  },
};

export const OWNER_TOOLS: OwnerTool[] = [createTask, sendEmail, sendText, callPerson, delegate, listApprovals, decideApproval, answerFriday, createEvent, findContact, ...MANAGE_TOOLS, ...FACTORY_TOOLS, ...CAIO_TOOLS, ...READ_TOOLS];

export const NOT_OWNER_LINE = "I can only look that up for the account owner.";

/** Run one tool for a turn, enforcing the owner gate. Never throws. */
export async function runTool(tool: OwnerTool | undefined, c: OwnerCtx, args: Record<string, unknown>, name = "?"): Promise<ToolResult> {
  if (!tool) return { ok: false, line: `I don't have a tool called ${name}.` };
  if (tool.ownerOnly && !c.ownerVerified) return { ok: false, line: NOT_OWNER_LINE };
  try {
    return await tool.run(c, args);
  } catch (e) {
    return { ok: false, line: `That failed unexpectedly (${String((e as Error).message).slice(0, 100)}). Nothing was changed.` };
  }
}

