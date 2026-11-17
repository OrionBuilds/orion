/**
 * What each event_outbox event_type becomes: bell title/body, email subject/heading/rows, the CTA,
 * the in-app deep link, recipients. Pure functions of the (enriched) payload so they can be tested;
 * notification-dispatcher supplies the payload (see notification-enrich.ts) and sends.
 *
 * Links are RELATIVE routes of the OS app (src/App.tsx); the dispatcher prefixes appBaseUrl() for
 * email and stores the relative path in notifications.link, which NotificationBell navigates to.
 */

export type Payload = Record<string, unknown>;
export type Mailbox = "info" | "admin" | "accounting" | "assigned";
export type ToastTarget = "admins" | "assigned";

export interface EventConfig {
  /** notifications.type (drives the bell icon) */
  notifType: string;
  emailTo: Mailbox[];
  toast: ToastTarget[];
  /** Return a reason to skip the event entirely, or null to proceed. */
  gate?: (p: Payload) => string | null;
  title: (p: Payload) => string;
  body: (p: Payload) => string;
  subject: (p: Payload) => string;
  heading: (p: Payload) => string;
  intro?: (p: Payload) => string;
  rows: (p: Payload) => Array<[string, string]>;
  ctaLabel: string;
  link: (entityId: string, p: Payload) => string | undefined;
}

// ── Formatting helpers ───────────────────────────────────────────────────────
export function s(p: Payload, key: string): string {
  const v = p[key];
  return v === null || v === undefined ? "" : String(v);
}

export function money(p: Payload, key: string): string {
  const v = p[key];
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  if (!isFinite(n) || n === 0) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

export const DEFAULT_TZ = "America/New_York";

/** "Tue, Nov 3, 2:00 PM EST" in the given zone (falls back to ET; invalid input → ""). */
export function fmtWhen(iso: unknown, tz?: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const zone = typeof tz === "string" && tz ? tz : DEFAULT_TZ;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(d);
  }
}

/** "Fri, Nov 6" for a date or timestamp; a bare YYYY-MM-DD is kept calendar-exact. */
export function fmtDue(v: unknown, tz?: unknown): string {
  if (typeof v !== "string" || !v) return "";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(v);
  const d = dateOnly ? new Date(`${v}T12:00:00Z`) : new Date(v);
  if (isNaN(d.getTime())) return v;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", timeZone: dateOnly ? "UTC" : (typeof tz === "string" && tz ? tz : DEFAULT_TZ) };
  if (!dateOnly) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

export function personName(p: Payload, prefix = "contact"): string {
  const full = s(p, `${prefix}_name`).trim();
  if (full) return full;
  const first = s(p, prefix === "contact" ? "first_name" : `${prefix}_first_name`);
  const last = s(p, prefix === "contact" ? "last_name" : `${prefix}_last_name`);
  return `${first} ${last}`.trim();
}

function cap(v: string): string {
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}

function fieldRows(p: Payload): Array<[string, string]> {
  const f = p.fields;
  if (!Array.isArray(f)) return [];
  return f
    .filter((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string")
    .map((x) => [String(x[0]), x[1] === null || x[1] === undefined ? "" : String(x[1])] as [string, string]);
}

// ── Link builders (relative) ─────────────────────────────────────────────────
export const LINKS = {
  task: (id: string) => `/calendars?tab=tasks&taskId=${encodeURIComponent(id)}`,
  appointment: (id: string) => `/calendars?tab=list&appointmentId=${encodeURIComponent(id)}`,
  opportunity: (id: string) => `/opportunities/${encodeURIComponent(id)}`,
  contact: (id: string) => `/contacts/${encodeURIComponent(id)}`,
  formSubmissions: (formId: string) => `/marketing/forms/${encodeURIComponent(formId)}/submissions`,
  proposal: (id: string) => `/proposals/${encodeURIComponent(id)}`,
  contract: (id: string) => `/contracts/${encodeURIComponent(id)}`,
  invoice: (id: string) => `/payments/invoices/${encodeURIComponent(id)}`,
  project: (id: string, tab?: string) => `/projects/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`,
  conversation: (id: string) => `/conversations/${encodeURIComponent(id)}`,
};

// ── Task (contact / project / personal) ──────────────────────────────────────
const taskEvent: EventConfig = {
  notifType: "task_assigned",
  emailTo: ["assigned"],
  toast: ["assigned"],
  title: (p) => `Task assigned: ${s(p, "title") || "Untitled"}`,
  body: (p) => {
    const who = s(p, "assigner_name");
    const about = s(p, "contact_name") ? ` for ${s(p, "contact_name")}` : s(p, "project_name") ? ` on ${s(p, "project_name")}` : "";
    const due = fmtDue(p.due ?? p.due_date ?? p.due_at_utc);
    return `${who ? `${who} assigned you` : "You were assigned"} "${s(p, "title")}"${about}${due ? ` · due ${due}` : ""}`;
  },
  subject: (p) => {
    const due = fmtDue(p.due ?? p.due_date ?? p.due_at_utc);
    return `Task assigned: ${s(p, "title") || "Untitled"}${due ? ` (due ${due})` : ""}`;
  },
  heading: (p) => s(p, "title") || "Task assigned to you",
  intro: (p) => {
    const who = s(p, "assigner_name") || "Someone";
    const kind = s(p, "task_kind") === "project" ? "project task" : s(p, "task_kind") === "personal" ? "task" : "contact task";
    return `${who} ${s(p, "via") === "reassign" ? "reassigned" : "assigned"} you a ${kind}.`;
  },
  rows: (p) => [
    ["For", s(p, "contact_name") ? `${s(p, "contact_name")}${s(p, "contact_company") ? ` · ${s(p, "contact_company")}` : ""}` : ""],
    ["Project", s(p, "project_name")],
    ["Due", fmtDue(p.due ?? p.due_date ?? p.due_at_utc) || "No due date"],
    ["Priority", cap(s(p, "priority"))],
    ["Assigned by", s(p, "assigner_name")],
    ["Description", s(p, "description")],
  ],
  ctaLabel: "Open task",
  link: (entityId, p) => LINKS.task(s(p, "task_id") || entityId),
};

// ── Appointments ─────────────────────────────────────────────────────────────
function apptRows(p: Payload): Array<[string, string]> {
  const answers = p.answers && typeof p.answers === "object" && !Array.isArray(p.answers) ? p.answers as Record<string, unknown> : {};
  const extra = Object.entries(answers)
    .filter(([k, v]) => !["name", "email", "phone"].includes(k) && v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`).join("\n");
  return [
    ["With", personName(p) || s(p, "answers_name")],
    ["Email", s(p, "contact_email") || s(p, "answers_email")],
    ["Phone", s(p, "contact_phone") || s(p, "answers_phone")],
    ["When", fmtWhen(p.start_at_utc, p.visitor_timezone)],
    ["Type", s(p, "appointment_type")],
    ["Calendar", s(p, "calendar_name")],
    ["Meet link", s(p, "google_meet_link")],
    ["Answers", extra],
  ];
}
function apptLabel(p: Payload): string {
  const who = personName(p) || s(p, "answers_name") || "a guest";
  const type = s(p, "appointment_type") || "Appointment";
  return `${type} with ${who}`;
}

const appointmentBooked: EventConfig = {
  notifType: "appointment_booked",
  emailTo: ["assigned"],
  toast: ["admins", "assigned"],
  title: (p) => `Booked: ${apptLabel(p)}`,
  body: (p) => `${apptLabel(p)} — ${fmtWhen(p.start_at_utc, p.visitor_timezone) || "time TBD"}`,
  subject: (p) => `Booked: ${apptLabel(p)} — ${fmtWhen(p.start_at_utc, p.visitor_timezone)}`.replace(/ — $/, ""),
  heading: (p) => apptLabel(p),
  intro: (p) => `A new appointment was booked${s(p, "calendar_name") ? ` on ${s(p, "calendar_name")}` : ""}.`,
  rows: apptRows,
  ctaLabel: "View appointment",
  link: (entityId, p) => LINKS.appointment(s(p, "appointment_id") || entityId),
};

const appointmentCanceled: EventConfig = {
  ...appointmentBooked,
  notifType: "appointment",
  emailTo: ["admin", "assigned"],
  title: (p) => `Cancelled: ${apptLabel(p)}`,
  body: (p) => `${apptLabel(p)} was cancelled (was ${fmtWhen(p.start_at_utc, p.visitor_timezone) || "unscheduled"})`,
  subject: (p) => `Cancelled: ${apptLabel(p)} — ${fmtWhen(p.start_at_utc, p.visitor_timezone)}`.replace(/ — $/, ""),
  intro: () => "This appointment was cancelled.",
};

const appointmentNoShow: EventConfig = {
  ...appointmentBooked,
  notifType: "appointment",
  emailTo: ["admin", "assigned"],
  title: (p) => `No-show: ${apptLabel(p)}`,
  body: (p) => `${personName(p) || "The contact"} did not show for ${s(p, "appointment_type") || "their appointment"}`,
  subject: (p) => `No-show: ${apptLabel(p)}`,
  intro: () => "The contact did not show up for this appointment.",
};

// ── Leads ────────────────────────────────────────────────────────────────────
function leadWho(p: Payload): string {
  const name = personName(p) || s(p, "email") || "Unknown";
  return s(p, "company") ? `${name} (${s(p, "company")})` : name;
}

const formSubmitted: EventConfig = {
  notifType: "system",
  emailTo: ["info", "assigned"],
  toast: ["admins"],
  title: (p) => `New lead: ${leadWho(p)}`,
  body: (p) => `${leadWho(p)} submitted ${s(p, "form_name") || "a form"}`,
  subject: (p) => `New lead: ${leadWho(p)} — ${s(p, "form_name") || "form submission"}`,
  heading: (p) => `New lead from ${s(p, "form_name") || "a form"}`,
  intro: (p) => `${leadWho(p)} just submitted ${s(p, "form_name") || "a form"}${s(p, "opportunity_id") ? (p.opportunity_created === false ? "; added to their open opportunity." : "; an Inbound / New Lead opportunity was created.") : "."}`,
  rows: (p) => [
    ["Name", personName(p)],
    ["Email", s(p, "email")],
    ["Phone", s(p, "phone")],
    ["Company", s(p, "company")],
    ["Page", s(p, "landing_page")],
    ...fieldRows(p),
  ],
  ctaLabel: "Open lead",
  link: (_e, p) =>
    s(p, "opportunity_id") ? LINKS.opportunity(s(p, "opportunity_id"))
    : s(p, "contact_id") ? LINKS.contact(s(p, "contact_id"))
    : s(p, "form_id") ? LINKS.formSubmissions(s(p, "form_id"))
    : "/marketing/forms",
};

const surveySubmitted: EventConfig = {
  notifType: "system",
  emailTo: ["info"],
  toast: ["admins"],
  title: (p) => `New survey response${s(p, "survey_name") ? `: ${s(p, "survey_name")}` : ""}`,
  body: (p) => `${personName(p) || s(p, "email") || "Someone"} answered ${s(p, "survey_name") || "a survey"}`,
  subject: (p) => `New survey response${s(p, "survey_name") ? `: ${s(p, "survey_name")}` : ""}`,
  heading: (p) => s(p, "survey_name") || "New survey response",
  rows: (p) => [["Name", personName(p)], ["Email", s(p, "email")], ...fieldRows(p)],
  ctaLabel: "View responses",
  link: (_e, p) => s(p, "survey_id") ? `/marketing/surveys/${encodeURIComponent(s(p, "survey_id"))}/submissions` : "/marketing",
};

const COVERED_LEAD_SOURCES = ["readiness-scorecard", "booking", "clara_web"];
const opportunityCreated: EventConfig = {
  notifType: "system",
  emailTo: ["info"],
  toast: ["admins", "assigned"],
  gate: (p) => {
    const src = s(p, "source");
    return src.startsWith("web_form_") || COVERED_LEAD_SOURCES.includes(src)
      ? `opportunity_created from ${src} is covered by its own event` : null;
  },
  title: (p) => `New opportunity: ${s(p, "name") || leadWho(p)}`,
  body: (p) => `${s(p, "name") || leadWho(p)}${s(p, "stage_name") ? ` · ${s(p, "stage_name")}` : ""}${money(p, "value_amount") ? ` · ${money(p, "value_amount")}` : ""}`,
  subject: (p) => `New opportunity: ${s(p, "name") || leadWho(p)}`,
  heading: (p) => s(p, "name") || "A new opportunity was created",
  rows: (p) => [
    ["Contact", leadWho(p)],
    ["Email", s(p, "email")],
    ["Stage", s(p, "stage_name")],
    ["Value", money(p, "value_amount")],
    ["Source", s(p, "source")],
    ["Assigned to", s(p, "assigned_name")],
  ],
  ctaLabel: "Open opportunity",
  link: (entityId, p) => LINKS.opportunity(s(p, "opportunity_id") || entityId),
};

const opportunityStatusChanged: EventConfig = {
  notifType: "system",
  emailTo: ["admin"],
  toast: ["admins", "assigned"],
  gate: (p) => {
    const st = String(p.new_status || p.status || "").toLowerCase();
    return st === "won" || st === "lost" ? null : "status not won/lost";
  },
  title: (p) => `Opportunity ${s(p, "new_status")}: ${s(p, "name") || leadWho(p)}`,
  body: (p) => `${s(p, "name") || leadWho(p)} was marked ${s(p, "new_status")}${money(p, "value_amount") ? ` (${money(p, "value_amount")})` : ""}`,
  subject: (p) => `Opportunity ${s(p, "new_status")}: ${s(p, "name") || leadWho(p)}`,
  heading: (p) => `${s(p, "name") || "Opportunity"} — ${s(p, "new_status")}`,
  rows: (p) => [["Contact", leadWho(p)], ["Status", cap(s(p, "new_status"))], ["Value", money(p, "value_amount")], ["Lost reason", s(p, "lost_reason")]],
  ctaLabel: "Open opportunity",
  link: (entityId, p) => LINKS.opportunity(s(p, "opportunity_id") || entityId),
};

// ── Documents, money, projects, conversations ────────────────────────────────
function simple(i: {
  notifType?: string; emailTo: Mailbox[]; toast: ToastTarget[];
  title: (p: Payload) => string; body: (p: Payload) => string; subject?: (p: Payload) => string;
  heading: (p: Payload) => string; rows: (p: Payload) => Array<[string, string]>; ctaLabel: string;
  link: (entityId: string, p: Payload) => string | undefined; gate?: (p: Payload) => string | null;
}): EventConfig {
  return { notifType: "system", subject: i.title, ...i };
}

const proposalSigned = simple({
  emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `Proposal signed: ${s(p, "title")}`,
  body: (p) => `"${s(p, "title")}" was signed${s(p, "signer_name") ? ` by ${s(p, "signer_name")}` : ""}`,
  heading: (p) => `Proposal signed: ${s(p, "title")}`,
  rows: (p) => [["Signed by", s(p, "signer_name") || s(p, "signer_email")], ["Value", money(p, "total_value")]],
  ctaLabel: "View proposal", link: (id) => LINKS.proposal(id),
});
const contractSigned = simple({
  emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `Contract signed: ${s(p, "title")}`,
  body: (p) => `"${s(p, "title")}" was signed${s(p, "signer_name") ? ` by ${s(p, "signer_name")}` : ""}`,
  heading: (p) => `Contract signed: ${s(p, "title")}`,
  rows: (p) => [["Signed by", s(p, "signer_name") || s(p, "signer_email")], ["Value", money(p, "total_value")]],
  ctaLabel: "View contract", link: (id) => LINKS.contract(id),
});
const proposalViewed = simple({
  emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `Proposal viewed: ${s(p, "title")}`,
  body: (p) => `The client opened "${s(p, "title")}"`,
  heading: (p) => `Proposal viewed: ${s(p, "title")}`,
  rows: () => [], ctaLabel: "View proposal", link: (id) => LINKS.proposal(id),
});
const proposalDeclined = simple({
  notifType: "warning", emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `Proposal declined: ${s(p, "title")}`,
  body: (p) => `"${s(p, "title")}" was declined`,
  heading: (p) => `Proposal declined: ${s(p, "title")}`,
  rows: () => [], ctaLabel: "View proposal", link: (id) => LINKS.proposal(id),
});
const changeRequestCreated = simple({
  notifType: "change_request", emailTo: ["admin", "assigned"], toast: ["admins", "assigned"],
  title: (p) => `Change request: ${s(p, "title")}`,
  body: (p) => `${s(p, "client_name") || "A client"} submitted "${s(p, "title")}"${s(p, "project_name") ? ` on ${s(p, "project_name")}` : ""}`,
  heading: (p) => `New change request: ${s(p, "title")}`,
  rows: (p) => [["Project", s(p, "project_name")], ["From", s(p, "client_name")], ["Type", s(p, "request_type")], ["Priority", cap(s(p, "priority"))], ["Description", s(p, "description")]],
  ctaLabel: "Review change request", link: (_e, p) => LINKS.project(s(p, "project_id"), "change_requests"),
});
const supportTicketCreated = simple({
  notifType: "support_ticket", emailTo: ["admin", "assigned"], toast: ["admins", "assigned"],
  title: (p) => `Support ticket: ${s(p, "title")}`,
  body: (p) => `${s(p, "client_name") || "A client"} opened "${s(p, "title")}"${s(p, "ticket_number") ? ` (${s(p, "ticket_number")})` : ""}`,
  heading: (p) => `New support ticket: ${s(p, "title")}`,
  rows: (p) => [["Project", s(p, "project_name")], ["Ticket #", s(p, "ticket_number")], ["From", s(p, "client_name")], ["Priority", cap(s(p, "priority"))], ["Description", s(p, "description")]],
  ctaLabel: "View ticket", link: (_e, p) => LINKS.project(s(p, "project_id"), "support_tickets"),
});
const invoiceCreated = simple({
  emailTo: ["accounting"], toast: ["admins"],
  title: (p) => `Invoice ${s(p, "doc_number") || "created"}`,
  body: (p) => `Invoice ${s(p, "doc_number")} created${money(p, "total") ? ` for ${money(p, "total")}` : ""}${s(p, "contact_name") ? ` · ${s(p, "contact_name")}` : ""}`,
  heading: (p) => `Invoice ${s(p, "doc_number")} created`,
  rows: (p) => [["Customer", s(p, "contact_name")], ["Amount", money(p, "total")], ["Status", cap(s(p, "status"))], ["Due", fmtDue(p.due_date)]],
  ctaLabel: "View invoice", link: (id) => LINKS.invoice(id),
});
const invoicePaid = simple({
  emailTo: ["accounting"], toast: ["admins"],
  title: (p) => `Invoice ${s(p, "doc_number")} paid`,
  body: (p) => `Invoice ${s(p, "doc_number")} was paid${money(p, "total") ? ` (${money(p, "total")})` : ""}${s(p, "contact_name") ? ` by ${s(p, "contact_name")}` : ""}`,
  heading: (p) => `Invoice ${s(p, "doc_number")} paid`,
  rows: (p) => [["Customer", s(p, "contact_name")], ["Amount", money(p, "total")]],
  ctaLabel: "View invoice", link: (id) => LINKS.invoice(id),
});
const invoiceOverdue = simple({
  notifType: "warning", emailTo: ["accounting", "assigned"], toast: ["admins"],
  title: (p) => `Invoice ${s(p, "doc_number")} overdue`,
  body: (p) => `Invoice ${s(p, "doc_number")} is overdue${money(p, "total") ? ` (${money(p, "total")})` : ""}`,
  heading: (p) => `Invoice ${s(p, "doc_number")} is overdue`,
  rows: (p) => [["Customer", s(p, "contact_name")], ["Amount", money(p, "total")], ["Was due", fmtDue(p.due_date)]],
  ctaLabel: "View invoice", link: (id) => LINKS.invoice(id),
});
const paymentReceived = simple({
  emailTo: ["accounting"], toast: ["admins"],
  title: (p) => `Payment received${money(p, "amount") ? `: ${money(p, "amount")}` : ""}`,
  body: (p) => `Payment received${money(p, "amount") ? ` of ${money(p, "amount")}` : ""}${s(p, "contact_name") ? ` from ${s(p, "contact_name")}` : ""}`,
  heading: () => "Payment received",
  rows: (p) => [["From", s(p, "contact_name")], ["Amount", money(p, "amount")], ["Invoice #", s(p, "doc_number")]],
  ctaLabel: "View payments", link: (_e, p) => s(p, "invoice_id") ? LINKS.invoice(s(p, "invoice_id")) : "/payments",
});
const conversationAssigned = simple({
  notifType: "conversation_assigned", emailTo: ["assigned"], toast: ["assigned"],
  title: (p) => `Conversation assigned: ${personName(p) || s(p, "channel") || "new"}`,
  body: (p) => `A ${s(p, "channel") || "conversation"}${personName(p) ? ` with ${personName(p)}` : ""} was assigned to you`,
  heading: (p) => `Conversation assigned to you${personName(p) ? `: ${personName(p)}` : ""}`,
  rows: (p) => [["Contact", personName(p)], ["Email", s(p, "contact_email")], ["Phone", s(p, "contact_phone")], ["Channel", cap(s(p, "channel"))], ["Last message", s(p, "last_message")]],
  ctaLabel: "Open conversation", link: (entityId, p) => LINKS.conversation(s(p, "conversation_id") || entityId),
});
const projectCreated = simple({
  emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `New project: ${s(p, "name")}`,
  body: (p) => `Project "${s(p, "name")}" was created${s(p, "contact_name") ? ` for ${s(p, "contact_name")}` : ""}`,
  heading: (p) => `New project: ${s(p, "name")}`,
  rows: (p) => [["Client", s(p, "contact_name")], ["Status", cap(s(p, "status"))]],
  ctaLabel: "Open project", link: (entityId, p) => LINKS.project(s(p, "project_id") || entityId),
});
const projectCompleted = simple({
  emailTo: ["admin"], toast: ["admins", "assigned"],
  title: (p) => `Project completed: ${s(p, "name")}`,
  body: (p) => `Project "${s(p, "name")}" was completed`,
  heading: (p) => `Project completed: ${s(p, "name")}`,
  rows: (p) => [["Client", s(p, "contact_name")]],
  ctaLabel: "Open project", link: (entityId, p) => LINKS.project(s(p, "project_id") || entityId),
});
const aiAgentFailed = simple({
  notifType: "warning", emailTo: ["admin"], toast: ["admins"],
  title: (p) => `AI agent run failed${s(p, "agent_name") ? `: ${s(p, "agent_name")}` : ""}`,
  body: (p) => `An AI agent run failed${s(p, "error_message") ? `: ${s(p, "error_message")}` : ""}`,
  heading: () => "An AI agent run failed",
  rows: (p) => [["Agent", s(p, "agent_name")], ["Error", s(p, "error_message")]],
  ctaLabel: "View AI agents", link: () => "/settings/ai-agents",
});

export const EVENTS: Record<string, EventConfig> = {
  task_assigned: taskEvent,
  /** Legacy emitter (dropped by the task_assigned migration); same rendering. */
  contact_task_added: taskEvent,
  appointment_booked: appointmentBooked,
  appointment_canceled: appointmentCanceled,
  appointment_no_show: appointmentNoShow,
  form_submitted: formSubmitted,
  survey_submitted: surveySubmitted,
  opportunity_created: opportunityCreated,
  opportunity_status_changed: opportunityStatusChanged,
  proposal_signed: proposalSigned,
  proposal_viewed: proposalViewed,
  proposal_declined: proposalDeclined,
  contract_signed: contractSigned,
  change_request_created: changeRequestCreated,
  support_ticket_created: supportTicketCreated,
  invoice_created: invoiceCreated,
  invoice_paid: invoicePaid,
  invoice_overdue: invoiceOverdue,
  payment_received: paymentReceived,
  conversation_assigned: conversationAssigned,
  project_created: projectCreated,
  project_completed: projectCompleted,
  ai_agent_failed: aiAgentFailed,
};

/**
 * Owner-first: these flow into the daily brief + bell, so their per-event admin@ email is trimmed.
 * Team mailboxes are untouched (accounting@ on invoices, info@ on leads).
 */
export const BRIEF_BOUND_EVENT_TYPES = new Set<string>([
  "opportunity_created", "opportunity_status_changed",
  "proposal_signed", "proposal_viewed", "proposal_declined", "contract_signed",
  "project_created", "project_completed", "ai_agent_failed",
]);

export interface RenderedEvent {
  title: string;
  body: string;
  link: string | null;
  subject: string;
  heading: string;
  intro?: string;
  rows: Array<[string, string]>;
  cta?: { label: string; url: string };
}

export function renderEvent(cfg: EventConfig, p: Payload, entityId: string, appBase: string): RenderedEvent {
  const link = cfg.link(entityId, p) || null;
  const base = appBase.replace(/\/+$/, "");
  return {
    title: cfg.title(p),
    body: cfg.body(p),
    link,
    subject: cfg.subject(p),
    heading: cfg.heading(p),
    intro: cfg.intro?.(p),
    rows: cfg.rows(p),
    cta: link ? { label: cfg.ctaLabel, url: `${base}${link}` } : undefined,
  };
}
