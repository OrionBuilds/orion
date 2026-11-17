/**
 * Shared CRM writes for every unattended website lead path (form-submit,
 * site-lead-intake, booking-api, scorecard-submit).
 *
 * Rules every path follows:
 *  - A contact is matched by email (oldest active, unmerged row wins, case-insensitive);
 *    an existing contact is gap-filled only, never overwritten.
 *  - One OPEN opportunity per contact in the Inbound pipeline. A repeat submission or a
 *    booking appends to that opportunity instead of stacking a new "New Lead" card.
 *  - Service-role writes set `created_by` / `owner_id` explicitly (auth.uid() is NULL).
 *  - Nobody here emits `opportunity_created`: the DB trigger covers sources that don't
 *    start with `web_form_`, and web forms notify through the richer `form_submitted`.
 */
/** Any supabase-js client (typed or not) or the in-memory FakeSupabase used by tests. */
// deno-lint-ignore no-explicit-any
export type Db = { from: (table: string) => any };
type Row = Record<string, unknown>;

// ── Constants (set these env vars to your org's ids; empty = not configured) ────────
export const LEAD_ORG_ID = Deno.env.get("SCORECARD_ORG_ID") ?? "00000000-0000-0000-0000-000000000001";
export const LEAD_PIPELINE_ID = Deno.env.get("CLARA_LEAD_PIPELINE_ID") ?? ""; // Inbound
export const LEAD_STAGE_ID = Deno.env.get("CLARA_LEAD_STAGE_ID") ?? ""; // New Lead
export const LEAD_DEPARTMENT_ID = Deno.env.get("CLARA_LEAD_DEPARTMENT_ID") ?? ""; // Sales
export const LEAD_OWNER_USER_ID = Deno.env.get("CLARA_LEAD_OWNER_ID") ?? ""; // lead owner / assignee
/** Actor for created_by / timeline rows: the System Administrator, so unattended leads don't inflate anyone's stats. */
export const LEAD_ACTOR_USER_ID = Deno.env.get("SCORECARD_ACTOR_USER_ID") ?? "";

const DESCRIPTION_MAX = 4000;

// ── Pure helpers ──────────────────────────────────────────────────────────────
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

export function splitName(full: unknown): { firstName: string; lastName: string } {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function trimTo(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Contacts ─────────────────────────────────────────────────────────────────
export interface ContactMatch {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  owner_id: string | null;
}

const CONTACT_COLS = "id, first_name, last_name, email, phone, company, job_title, owner_id";

/** Oldest active, unmerged contact with this email; exact match first, then case-insensitive. */
export async function findContactByEmail(db: Db, orgId: string, rawEmail: unknown): Promise<ContactMatch | null> {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  const base = () =>
    db.from("contacts").select(CONTACT_COLS)
      .eq("organization_id", orgId)
      .eq("status", "active")
      .is("merged_into_contact_id", null)
      .order("created_at", { ascending: true })
      .limit(1);
  const exact = await base().eq("email", email).maybeSingle();
  if (exact.data) return exact.data as ContactMatch;
  const loose = await base().ilike("email", email).maybeSingle();
  return (loose.data as ContactMatch | null) ?? null;
}

export interface ContactFields {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  /** Only pass a phone the visitor consented to be contacted on. */
  phone?: string | null;
}

export interface ContactCreateOpts {
  source: string;
  ownerId?: string;
  departmentId?: string;
  actorUserId?: string;
  /** Client brand (contacts.brand); omitted = the column default. Never changed on an existing contact. */
  brand?: string | null;
}

/** Find by email and gap-fill, else create. Never touches source/owner/department on an existing contact. */
export async function upsertContactByEmail(
  db: Db,
  orgId: string,
  f: ContactFields,
  o: ContactCreateOpts,
): Promise<{ id: string; created: boolean }> {
  const email = normalizeEmail(f.email);
  if (!email) throw new Error("upsertContactByEmail: invalid email");

  const existing = await findContactByEmail(db, orgId, email);
  if (existing) {
    const upd: Row = {};
    if (!existing.first_name && f.firstName) upd.first_name = f.firstName;
    if (!existing.last_name && f.lastName) upd.last_name = f.lastName;
    if (!existing.company && f.company) upd.company = f.company;
    if (!existing.job_title && f.jobTitle) upd.job_title = f.jobTitle;
    if (!existing.phone && f.phone) upd.phone = f.phone;
    if (Object.keys(upd).length) {
      const { error } = await db.from("contacts").update(upd).eq("id", existing.id);
      if (error) console.warn("[lead-intake] contact gap-fill failed:", error.message);
    }
    return { id: existing.id, created: false };
  }

  const { data, error } = await db.from("contacts").insert({
    organization_id: orgId,
    department_id: o.departmentId ?? LEAD_DEPARTMENT_ID,
    owner_id: o.ownerId ?? LEAD_OWNER_USER_ID,
    status: "active",
    first_name: f.firstName || "",
    last_name: f.lastName || "",
    email,
    phone: f.phone || null,
    company: f.company || null,
    job_title: f.jobTitle || null,
    source: o.source,
    created_by_user_id: o.actorUserId ?? LEAD_ACTOR_USER_ID,
    ...(o.brand ? { brand: o.brand } : {}),
  }).select("id").single();
  if (error || !data) throw new Error(`contact insert failed: ${error?.message ?? "no row"}`);
  return { id: data.id as string, created: true };
}

export async function addContactTimeline(
  db: Db,
  contactId: string,
  eventType: string,
  eventData: Row,
  userId: string | null = null,
): Promise<void> {
  const { error } = await db.from("contact_timeline").insert({
    contact_id: contactId, user_id: userId, event_type: eventType, event_data: eventData,
  });
  if (error) console.warn("[lead-intake] contact_timeline insert failed:", error.message);
}

// ── Opportunities ────────────────────────────────────────────────────────────
export interface OpenOpportunity { id: string; stage_id: string; source: string | null; description: string | null }

/** Newest open opportunity for the contact in the given pipeline (default: Inbound), any source. */
export async function findOpenOpportunity(
  db: Db,
  orgId: string,
  contactId: string,
  o: { pipelineId?: string; source?: string } = {},
): Promise<OpenOpportunity | null> {
  let q = db.from("opportunities").select("id, stage_id, source, description")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .eq("pipeline_id", o.pipelineId ?? LEAD_PIPELINE_ID);
  if (o.source) q = q.eq("source", o.source);
  const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as OpenOpportunity | null) ?? null;
}

export interface OpportunityInput {
  source: string;
  name: string;
  description: string;
  pipelineId?: string;
  stageId?: string;
  assignedUserId?: string | null;
  createdBy?: string;
  departmentId?: string;
  valueAmount?: number;
  externalSourceId?: string | null;
}

export interface OpportunityTimeline {
  /** event_type + summary when a new opportunity is created */
  created: { eventType: string; summary: string; payload?: Row };
  /** event_type + summary when an open opportunity is reused */
  reused: { eventType: string; summary: string; payload?: Row };
  actorUserId?: string;
}

/**
 * Reuse the contact's open Inbound opportunity (append the new activity to its description and
 * log a timeline event) or create one in New Lead. Never emits `opportunity_created`.
 */
export async function findOrCreateOpenOpportunity(
  db: Db,
  orgId: string,
  contactId: string,
  i: OpportunityInput,
  t: OpportunityTimeline,
): Promise<{ id: string; created: boolean }> {
  const actor = t.actorUserId ?? LEAD_ACTOR_USER_ID;
  const open = await findOpenOpportunity(db, orgId, contactId, { pipelineId: i.pipelineId });

  if (open) {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const appended = `${open.description ?? ""}\n\n— ${stamp} UTC · ${i.source} —\n${i.description}`.trim();
    const { error } = await db.from("opportunities")
      .update({ description: trimTo(appended, DESCRIPTION_MAX) })
      .eq("id", open.id);
    if (error) console.warn("[lead-intake] opportunity append failed:", error.message);
    await db.from("opportunity_timeline_events").insert({
      org_id: orgId, opportunity_id: open.id, contact_id: contactId,
      event_type: t.reused.eventType, summary: t.reused.summary,
      payload: { source: i.source, ...(t.reused.payload ?? {}) }, actor_user_id: actor,
    });
    return { id: open.id, created: false };
  }

  const { data, error } = await db.from("opportunities").insert({
    org_id: orgId,
    contact_id: contactId,
    pipeline_id: i.pipelineId ?? LEAD_PIPELINE_ID,
    stage_id: i.stageId ?? LEAD_STAGE_ID,
    assigned_user_id: i.assignedUserId === undefined ? LEAD_OWNER_USER_ID : i.assignedUserId,
    department_id: i.departmentId ?? LEAD_DEPARTMENT_ID,
    value_amount: i.valueAmount ?? 0,
    currency: "USD",
    status: "open",
    source: i.source,
    name: trimTo(i.name, 120),
    description: trimTo(i.description, DESCRIPTION_MAX),
    external_source_id: i.externalSourceId ?? null,
    created_by: i.createdBy ?? actor,
  }).select("id").single();
  if (error || !data) throw new Error(`opportunity insert failed: ${error?.message ?? "no row"}`);

  await db.from("opportunity_timeline_events").insert({
    org_id: orgId, opportunity_id: data.id, contact_id: contactId,
    event_type: t.created.eventType, summary: t.created.summary,
    payload: { source: i.source, ...(t.created.payload ?? {}) }, actor_user_id: actor,
  });
  return { id: data.id as string, created: true };
}

// ── Form submissions + outbox ────────────────────────────────────────────────
export async function findSubmissionByKey(db: Db, idempotencyKey: string): Promise<{ id: string; contact_id: string | null; payload: Row } | null> {
  const { data } = await db.from("form_submissions").select("id, contact_id, payload")
    .eq("idempotency_key", idempotencyKey).limit(1).maybeSingle();
  return (data as { id: string; contact_id: string | null; payload: Row } | null) ?? null;
}

export async function recordFormSubmission(
  db: Db,
  orgId: string,
  i: { formId: string; contactId: string | null; payload: Row; attribution?: Row; idempotencyKey?: string | null },
): Promise<{ id: string; duplicate: boolean }> {
  if (i.idempotencyKey) {
    const dup = await findSubmissionByKey(db, i.idempotencyKey);
    if (dup) return { id: dup.id, duplicate: true };
  }
  const { data, error } = await db.from("form_submissions").insert({
    organization_id: orgId,
    form_id: i.formId,
    contact_id: i.contactId,
    payload: i.payload,
    attribution: i.attribution ?? {},
    processed_status: "processed",
    idempotency_key: i.idempotencyKey ?? null,
  }).select("id").single();
  if (error?.code === "23505" && i.idempotencyKey) {
    // Lost the race to an overlapping delivery of the same envelope (unique index on site: keys).
    const winner = await findSubmissionByKey(db, i.idempotencyKey);
    if (winner) return { id: winner.id, duplicate: true };
  }
  if (error || !data) throw new Error(`form_submissions insert failed: ${error?.message ?? "no row"}`);
  return { id: data.id as string, duplicate: false };
}

export interface FormSubmittedPayload extends Row {
  form_id: string;
  form_name: string;
  form_slug: string | null;
  submission_id: string;
  contact_id: string | null;
  opportunity_id: string | null;
  first_name: string;
  last_name: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  landing_page: string;
  /** [label, value] pairs in form order, already stringified for display. */
  fields: [string, string][];
}

/** The outbox payload notification-dispatcher renders; every value is display-ready. */
export function buildFormSubmittedPayload(i: {
  formId: string;
  formName: string;
  formSlug?: string | null;
  submissionId: string;
  contactId: string | null;
  opportunityId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  landingPage?: string | null;
  fields?: [string, unknown][];
}): FormSubmittedPayload {
  const first = (i.firstName ?? "").trim();
  const last = (i.lastName ?? "").trim();
  return {
    form_id: i.formId,
    form_name: i.formName,
    form_slug: i.formSlug ?? null,
    submission_id: i.submissionId,
    contact_id: i.contactId,
    opportunity_id: i.opportunityId ?? null,
    first_name: first,
    last_name: last,
    name: `${first} ${last}`.trim(),
    email: (i.email ?? "").trim(),
    phone: (i.phone ?? "").trim(),
    company: (i.company ?? "").trim(),
    landing_page: (i.landingPage ?? "").trim(),
    fields: (i.fields ?? [])
      .map(([label, v]) => [label, displayValue(v)] as [string, string])
      .filter(([, v]) => v !== ""),
  };
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(displayValue).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

export async function emitFormSubmitted(
  db: Db,
  orgId: string,
  payload: FormSubmittedPayload,
): Promise<void> {
  const { error } = await db.from("event_outbox").insert({
    org_id: orgId,
    event_type: "form_submitted",
    contact_id: payload.contact_id,
    entity_type: "form_submission",
    entity_id: payload.submission_id,
    payload,
  });
  if (error) console.warn("[lead-intake] outbox form_submitted failed:", error.message);
}
