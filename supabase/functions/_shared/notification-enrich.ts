/**
 * Loads the entity behind an event_outbox row so the notification can say what happened: the task
 * and who assigned it, the appointment with its type/contact/time, the lead with every field, the
 * opportunity with its contact and stage. DB values win over the (often thin) trigger payload.
 * Every load is best-effort: a missing row leaves the payload as it was.
 */
import type { Db } from "./lead-intake.ts";
import type { Payload } from "./notification-events.ts";

type Row = Record<string, unknown>;

export interface OutboxEvent {
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  contact_id: string | null;
  payload: Payload;
}

async function one(db: Db, table: string, cols: string, id: string | null | undefined): Promise<Row | null> {
  if (!id) return null;
  try {
    const { data } = await db.from(table).select(cols).eq("id", id).maybeSingle();
    return (data as Row | null) ?? null;
  } catch {
    return null;
  }
}

function contactFields(c: Row | null): Payload {
  if (!c) return {};
  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return {
    contact_id: c.id,
    contact_name: name,
    contact_email: c.email ?? "",
    contact_phone: c.phone ?? "",
    contact_company: c.company ?? "",
    // lead renderers read these
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    company: c.company ?? "",
  };
}

const CONTACT_COLS = "id, first_name, last_name, email, phone, company";
const USER_COLS = "id, name, email";

async function userName(db: Db, id: unknown): Promise<string> {
  if (typeof id !== "string" || !id) return "";
  const u = await one(db, "users", USER_COLS, id);
  return (u?.name as string) || (u?.email as string) || "";
}

async function enrichTask(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const kind = (p.task_kind as string) || (e.event_type === "contact_task_added" ? "contact" : "contact");
  const taskId = (p.task_id as string) || e.entity_id;
  const out: Payload = { task_kind: kind, task_id: taskId };

  const table = kind === "project" ? "project_tasks" : kind === "personal" ? "calendar_tasks" : "contact_tasks";
  const cols = kind === "project"
    ? "id, title, description, due_date, priority, assigned_user_id, created_by, project_id"
    : kind === "personal"
    ? "id, title, description, due_at_utc, priority, user_id, created_by"
    : "id, title, description, due_date, priority, assigned_to_user_id, created_by_user_id, contact_id";
  const t = await one(db, table, cols, taskId);
  if (t) {
    out.title = t.title;
    out.description = t.description ?? "";
    out.due = t.due_date ?? t.due_at_utc ?? null;
    out.priority = t.priority;
    out.assigned_to_user_id = t.assigned_to_user_id ?? t.assigned_user_id ?? t.user_id ?? p.assigned_to_user_id;
    if (!p.assigner_user_id) out.assigner_user_id = t.created_by_user_id ?? t.created_by ?? null;
    if (t.contact_id) out.contact_id = t.contact_id;
    if (t.project_id) out.project_id = t.project_id;
  }
  const [assignerName, contact, project] = await Promise.all([
    userName(db, p.assigner_user_id ?? out.assigner_user_id),
    one(db, "contacts", CONTACT_COLS, (out.contact_id ?? p.contact_id ?? e.contact_id) as string | null),
    one(db, "projects", "id, name", (out.project_id ?? p.project_id) as string | null),
  ]);
  if (assignerName) out.assigner_name = assignerName;
  if (contact) Object.assign(out, { contact_name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(), contact_company: contact.company ?? "" });
  if (project) out.project_name = project.name;
  return out;
}

async function enrichAppointment(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const id = (p.appointment_id as string) || e.entity_id;
  const a = await one(db, "appointments", "id, calendar_id, appointment_type_id, contact_id, assigned_user_id, status, start_at_utc, end_at_utc, visitor_timezone, answers, google_meet_link", id);
  const out: Payload = { appointment_id: id };
  const answers = (a?.answers ?? p.answers ?? {}) as Record<string, unknown>;
  if (a) {
    Object.assign(out, {
      calendar_id: a.calendar_id, appointment_type_id: a.appointment_type_id, assigned_user_id: a.assigned_user_id,
      status: a.status, start_at_utc: a.start_at_utc, end_at_utc: a.end_at_utc, visitor_timezone: a.visitor_timezone,
      google_meet_link: a.google_meet_link ?? "", answers,
      answers_name: answers.name ?? "", answers_email: answers.email ?? "", answers_phone: answers.phone ?? "",
    });
  }
  const [type, calendar, contact] = await Promise.all([
    one(db, "appointment_types", "id, name", (out.appointment_type_id ?? p.appointment_type_id) as string | null),
    one(db, "calendars", "id, name, slug", (out.calendar_id ?? p.calendar_id) as string | null),
    one(db, "contacts", CONTACT_COLS, (a?.contact_id ?? p.contact_id ?? e.contact_id) as string | null),
  ]);
  if (type) out.appointment_type = type.name;
  if (calendar) { out.calendar_name = calendar.name; out.calendar_slug = calendar.slug; }
  Object.assign(out, contactFields(contact));
  return out;
}

async function enrichFormSubmission(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const id = (p.submission_id as string) || e.entity_id;
  const sub = await one(db, "form_submissions", "id, form_id, contact_id, payload, attribution", id);
  const out: Payload = {};
  const formId = (sub?.form_id ?? p.form_id) as string | null;
  const contactId = (sub?.contact_id ?? p.contact_id ?? e.contact_id) as string | null;
  const [form, contact] = await Promise.all([
    one(db, "forms", "id, name, public_slug, definition", formId),
    one(db, "contacts", CONTACT_COLS, contactId),
  ]);
  if (form) { out.form_id = form.id; out.form_name = p.form_name ?? form.name; out.form_slug = form.public_slug; }
  if (contact) Object.assign(out, contactFields(contact));
  // Submitters' own values beat the contact row (the lead may have gap-filled nothing).
  for (const k of ["first_name", "last_name", "email", "phone", "company"] as const) {
    if (typeof p[k] === "string" && (p[k] as string).trim()) out[k] = p[k];
  }
  if (!Array.isArray(p.fields) && sub?.payload && form?.definition) {
    // Legacy events (thin payload): rebuild label/value pairs from the stored submission.
    const def = form.definition as { fields?: Array<{ id: string; label?: string }> };
    const sp = sub.payload as Record<string, unknown>;
    out.fields = (def.fields ?? [])
      .filter((f) => !f.id.startsWith("_"))
      .map((f) => [f.label || f.id, sp[f.id]])
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([l, v]) => [l, Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)]);
    const attr = (sub.attribution ?? {}) as Record<string, unknown>;
    if (!p.landing_page && attr.landing_page) out.landing_page = attr.landing_page;
  }
  // Opportunity: the one named in the payload, else the contact's newest open one.
  let oppId = (p.opportunity_id as string | null) ?? null;
  if (!oppId && contactId) {
    try {
      const { data } = await db.from("opportunities").select("id").eq("contact_id", contactId).eq("status", "open")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      oppId = (data?.id as string | undefined) ?? null;
    } catch { /* best effort */ }
  }
  if (oppId) {
    out.opportunity_id = oppId;
    const opp = await one(db, "opportunities", "id, assigned_user_id", oppId);
    if (opp?.assigned_user_id) out.assigned_user_id = opp.assigned_user_id;
  }
  return out;
}

async function enrichOpportunity(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const id = (p.opportunity_id as string) || e.entity_id;
  const o = await one(db, "opportunities", "id, name, value_amount, currency, source, status, stage_id, assigned_user_id, contact_id, lost_reason", id);
  const out: Payload = { opportunity_id: id };
  if (o) Object.assign(out, { name: o.name ?? "", value_amount: o.value_amount, currency: o.currency, source: o.source, assigned_user_id: o.assigned_user_id, lost_reason: p.lost_reason ?? o.lost_reason ?? "" });
  const [stage, contact, assignedName] = await Promise.all([
    one(db, "pipeline_stages", "id, name", (o?.stage_id ?? p.stage_id) as string | null),
    one(db, "contacts", CONTACT_COLS, (o?.contact_id ?? p.contact_id ?? e.contact_id) as string | null),
    userName(db, o?.assigned_user_id ?? p.assigned_user_id),
  ]);
  if (stage) out.stage_name = stage.name;
  Object.assign(out, contactFields(contact));
  if (assignedName) out.assigned_name = assignedName;
  return out;
}

async function enrichConversation(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const id = (p.conversation_id as string) || e.entity_id;
  const c = await one(db, "conversations", "id, contact_id, assigned_user_id, channel", id);
  const out: Payload = { conversation_id: id };
  if (c) Object.assign(out, { channel: c.channel ?? p.channel, assigned_user_id: c.assigned_user_id ?? p.assigned_user_id });
  const contact = await one(db, "contacts", CONTACT_COLS, (c?.contact_id ?? p.contact_id ?? e.contact_id) as string | null);
  Object.assign(out, contactFields(contact));
  return out;
}

async function enrichWithContactAndProject(db: Db, e: OutboxEvent): Promise<Payload> {
  const p = e.payload;
  const out: Payload = {};
  const [contact, project] = await Promise.all([
    one(db, "contacts", CONTACT_COLS, (p.contact_id ?? e.contact_id) as string | null),
    one(db, "projects", "id, name, status", (p.project_id ?? (e.entity_type === "project" ? e.entity_id : null)) as string | null),
  ]);
  if (contact) { const cf = contactFields(contact); out.contact_name = cf.contact_name; out.contact_email = cf.contact_email; }
  if (project) { out.project_name = project.name; if (e.entity_type === "project") { out.project_id = project.id; out.name = p.name ?? project.name; out.status = p.status ?? project.status; } }
  return out;
}

/** Returns the trigger payload merged with what the entity rows say (DB wins). */
export async function enrichEvent(db: Db, e: OutboxEvent): Promise<Payload> {
  let loaded: Payload = {};
  try {
    switch (e.event_type) {
      case "task_assigned":
      case "contact_task_added":
        loaded = await enrichTask(db, e); break;
      case "appointment_booked":
      case "appointment_canceled":
      case "appointment_no_show":
        loaded = await enrichAppointment(db, e); break;
      case "form_submitted":
        loaded = await enrichFormSubmission(db, e); break;
      case "opportunity_created":
      case "opportunity_status_changed":
        loaded = await enrichOpportunity(db, e); break;
      case "conversation_assigned":
        loaded = await enrichConversation(db, e); break;
      case "invoice_created":
      case "invoice_paid":
      case "invoice_overdue":
      case "payment_received":
      case "project_created":
      case "project_completed":
      case "change_request_created":
      case "support_ticket_created":
        loaded = await enrichWithContactAndProject(db, e); break;
      default:
        loaded = {};
    }
  } catch (err) {
    console.warn(`[notification-enrich] ${e.event_type} enrichment failed:`, err instanceof Error ? err.message : err);
  }
  const merged: Payload = { ...e.payload };
  for (const [k, v] of Object.entries(loaded)) {
    if (v !== undefined && v !== null && v !== "") merged[k] = v;
    else if (!(k in merged)) merged[k] = v;
  }
  return merged;
}

/** Users whose role name ends in "Agent" (Clara, Friday) never get alert email. */
export async function loadRecipient(db: Db, userId: string): Promise<{ id: string; email: string | null; name: string | null; isAgent: boolean } | null> {
  try {
    const { data } = await db.from("users").select("id, email, name, role:roles(name)").eq("id", userId).maybeSingle();
    if (!data) return null;
    const role = (data as Row).role as { name?: string } | { name?: string }[] | null;
    const roleName = Array.isArray(role) ? role[0]?.name : role?.name;
    return { id: data.id as string, email: (data.email as string) ?? null, name: (data.name as string) ?? null, isAgent: /agent$/i.test(roleName ?? "") };
  } catch {
    return null;
  }
}
