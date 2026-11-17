/**
 * Clara's management tools: the everyday changes the owner makes from his phone.
 *
 *   save_contact     add a person to the CRM, or change one (details, archive, do-not-contact)
 *   add_note         a note on a contact, a project or a deal
 *   update_task      complete / reopen / cancel / reschedule / reassign / rename a task
 *   create_project   open a delivery project (its pipeline's playbook starts with it)
 *   update_project   status, priority, target date, risk, progress, description
 *   change_booking   cancel or move a meeting booked through the OS (the guest is told)
 *   harvey_status    what Harvey (outbound) is doing
 *   harvey_command   pause / resume / sync Harvey
 *
 * All owner-only, and the same contract as owner-tools.ts: a tool did the thing and says so,
 * failed and says so, or asks one question. Anything else the OS can do goes to FRIDAY
 * (delegate_to_friday, kind task), who drives the OS's full tool set.
 */
import type { OwnerCtx, OwnerTool, ToolResult } from "./owner-tools.ts";
import { normalizeE164 } from "./phones.ts";
import { type Person, searchContacts } from "./contacts-search.ts";
import { asDetail } from "./owner-read-tools.ts";
import { BRAND_KEYS, isBrand } from "../brands.ts";
import { findDeal, pickStage } from "./factory-tools.ts";
import { personalCalendarId, resolveUser } from "./owner-helpers.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const has = (a: Record<string, unknown>, k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const like = (s: string) => s.replace(/[%_]/g, "");
const tzOf = (c: OwnerCtx) => c.env.get("CLARA_TZ") || "America/New_York";
const fmtWhen = (c: OwnerCtx, d: Date) => d.toLocaleString("en-US", { timeZone: tzOf(c), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const who = (p: Person) => `${p.name}${p.company ? ` (${p.company})` : ""}`;
/** Whoever the OS should record as the author: Clara where she has a user, else the owner. */
const actor = (c: OwnerCtx) => c.claraUserId ?? c.ownerUserId;

async function oneContact(c: OwnerCtx, q: string): Promise<{ person: Person } | ToolResult> {
  if (UUID_RE.test(q)) {
    const { data } = await c.db.from("contacts").select("id, first_name, last_name, email, phone, company").eq("organization_id", c.orgId).eq("id", q).maybeSingle();
    const r = data as Json | null;
    return r ? { person: { id: r.id, name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.company || "Unknown", email: r.email, phone: r.phone, company: r.company } } : { ok: false, line: "I can't find that contact." };
  }
  const people = await searchContacts(c.db, c.orgId, q, 5);
  if (people.length === 1) return { person: people[0] };
  return { ok: false, clarify: true, line: people.length ? `Which ${q}: ${people.slice(0, 4).map(who).join(", ")}?` : `I don't have a contact called "${q}".` };
}

async function oneProject(c: OwnerCtx, q: string): Promise<{ project: Json } | ToolResult> {
  const cols = "id, name, status, priority, pipeline_id, target_end_date";
  const { data } = UUID_RE.test(q)
    ? await c.db.from("projects").select(cols).eq("org_id", c.orgId).eq("id", q).limit(1)
    : await c.db.from("projects").select(cols).eq("org_id", c.orgId).ilike("name", `%${like(q)}%`).limit(6);
  let ps = (data ?? []) as Json[];
  const exact = ps.filter((p) => String(p.name).toLowerCase() === q.toLowerCase());
  if (exact.length === 1) ps = exact;
  if (ps.length === 1) return { project: ps[0] };
  return { ok: false, clarify: true, line: ps.length ? `Which project: ${ps.map((p) => p.name).join("; ")}?` : `I can't find a project matching "${q}".` };
}

// ── contacts ────────────────────────────────────────────────────────────────────────────────

const saveContact: OwnerTool = {
  name: "save_contact",
  ownerOnly: true,
  description: `Add a person to the CRM, or change an existing contact. To ADD: give name (plus any of email, phone, company, job_title). To CHANGE: give contact (the existing person's name, email or id) and only the fields that change; alternate_email adds a further address the person also writes from (their mail from it is then handled like the rest), without replacing their main email; archive=true removes them from the active list, do_not_contact=true/false sets the do-not-contact flag. brand is one of ${BRAND_KEYS.join(", ")}.`,
  input_schema: {
    type: "object",
    properties: {
      contact: { type: "string", description: "Existing contact to change (name, email or id). Omit to add a new one." },
      name: { type: "string", description: "Full name (new contact, or the corrected name)" },
      email: { type: "string" }, phone: { type: "string" }, company: { type: "string" }, job_title: { type: "string" },
      alternate_email: { type: "string", description: "A further address this existing contact also writes from (e.g. a personal Gmail). Keeps their main email." },
      brand: { type: "string", enum: BRAND_KEYS },
      archive: { type: "boolean" }, do_not_contact: { type: "boolean" },
    },
  },
  async run(c, a) {
    const fields: Json = {};
    const said: string[] = [];
    if (has(a, "email")) {
      if (!EMAIL_RE.test(str(a.email))) return { ok: false, clarify: true, line: `"${str(a.email)}" doesn't look like an email address. What is it?` };
      fields.email = str(a.email).toLowerCase(); said.push(`email ${fields.email}`);
    }
    let alt = "";
    if (has(a, "alternate_email")) {
      if (!EMAIL_RE.test(str(a.alternate_email))) return { ok: false, clarify: true, line: `"${str(a.alternate_email)}" doesn't look like an email address. What is it?` };
      alt = str(a.alternate_email).toLowerCase();
    }
    if (has(a, "phone")) {
      const p = normalizeE164(str(a.phone));
      if (!p) return { ok: false, clarify: true, line: `"${str(a.phone)}" doesn't look like a full phone number. What is it, with area code?` };
      fields.phone = p; said.push(`phone ${p}`);
    }
    if (has(a, "company")) { fields.company = str(a.company).slice(0, 200); said.push(`company ${fields.company}`); }
    if (has(a, "job_title")) { fields.job_title = str(a.job_title).slice(0, 200); said.push(`title ${fields.job_title}`); }
    if (isBrand(str(a.brand))) { fields.brand = str(a.brand); said.push(`brand ${fields.brand}`); }
    const [first, ...rest] = str(a.name).split(/\s+/).filter(Boolean);

    if (str(a.contact)) {
      const f = await oneContact(c, str(a.contact));
      if (!("person" in f)) return f;
      if (first) { fields.first_name = first.slice(0, 100); fields.last_name = rest.join(" ").slice(0, 100) || null; said.push(`name ${str(a.name)}`); }
      if (a.archive === true) { fields.status = "archived"; said.push("archived"); }
      if (typeof a.do_not_contact === "boolean") { fields.dnc = a.do_not_contact; said.push(a.do_not_contact ? "marked do-not-contact" : "do-not-contact cleared"); }
      if (!said.length && !alt) return { ok: false, clarify: true, line: `What should I change on ${f.person.name}?` };
      const detail = asDetail({ id: f.person.id, link: `/contacts/${f.person.id}` });
      if (said.length) {
        const { data, error } = await c.db.from("contacts").update(fields).eq("organization_id", c.orgId).eq("id", f.person.id).select("id");
        if (error || !(data as unknown[] | null)?.length) return { ok: false, line: `I couldn't update ${f.person.name}: ${error?.message ?? "no row changed"}. Nothing was changed.` };
      }
      const done = said.length ? `Updated ${f.person.name}: ${said.join(", ")}.` : "";
      if (!alt) return { ok: true, line: done, detail };
      // A further address: one contact per address, so a sender always resolves to one person.
      const { error: altErr } = await c.db.from("contact_emails").insert({ organization_id: c.orgId, contact_id: f.person.id, email: alt, source: "clara", created_by: actor(c) });
      if (altErr) {
        const why = altErr.code === "23505" ? `${alt} already belongs to a contact in the CRM` : altErr.message;
        return { ok: false, line: `${done ? `${done} But ` : ""}I couldn't add ${alt} to ${f.person.name}: ${why}.${done ? "" : " Nothing was changed."}` };
      }
      return { ok: true, line: `${done ? `${done} ` : ""}Added ${alt} as another address for ${f.person.name}. Mail from it will be picked up from now on, and I'm pulling in what they already sent.`, detail };
    }

    if (alt) return { ok: false, clarify: true, line: "Whose other address is that? Give me the existing contact." };
    if (!first) return { ok: false, clarify: true, line: "What's the person's name?" };
    // Never a second record for the same person: the email or number decides.
    if (fields.email) {
      const { data } = await c.db.from("contacts").select("id, first_name, last_name, company, email").eq("organization_id", c.orgId).ilike("email", fields.email.replace(/%/g, "")).limit(5);
      const dup = ((data ?? []) as Json[]).find((r) => String(r.email).toLowerCase() === fields.email);
      if (dup) return { ok: false, clarify: true, line: `${`${dup.first_name ?? ""} ${dup.last_name ?? ""}`.trim() || "Someone"}${dup.company ? ` (${dup.company})` : ""} already has ${fields.email} in the CRM. Should I update that record instead?` };
    }
    if (fields.phone) {
      const { data } = await c.db.rpc("find_contact_id_by_phone", { p_org: c.orgId, p_phone: fields.phone });
      if (data) return { ok: false, clarify: true, line: `${fields.phone} already belongs to a contact in the CRM. Should I update that record instead?` };
    }
    const { data, error } = await c.db.from("contacts").insert({
      organization_id: c.orgId, first_name: first.slice(0, 100), last_name: rest.join(" ").slice(0, 100) || null, ...fields,
      source: "clara", status: "active", owner_id: c.ownerUserId, created_by_user_id: actor(c),
    }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't add ${str(a.name)}: ${error?.message ?? "no row returned"}. Nothing was saved.` };
    return { ok: true, line: `Added ${str(a.name)} to the CRM${said.length ? ` (${said.join(", ")})` : ""}.`, detail: asDetail({ id: (data as Json).id, link: `/contacts/${(data as Json).id}` }) };
  },
};

const addNote: OwnerTool = {
  name: "add_note",
  ownerOnly: true,
  description: "Write a note on a contact, a project or a deal, in the owner's words. about is the name; on says which kind when the name could be either (default: contact, then project).",
  input_schema: {
    type: "object", required: ["about", "note"],
    properties: { about: { type: "string" }, note: { type: "string" }, on: { type: "string", enum: ["contact", "project", "deal"] } },
  },
  async run(c, a) {
    const about = str(a.about), note = str(a.note), on = str(a.on);
    if (!about || !note) return { ok: false, clarify: true, line: "Who or what is the note about, and what should it say?" };
    const by = actor(c);
    if (!by) return { ok: false, line: "I couldn't save the note: no OS user is configured for me (CLARA_USER_ID)." };
    const body = note.slice(0, 8000);
    const failed = (e: { message: string } | null) => ({ ok: false, line: `I couldn't save the note: ${e?.message ?? "no row returned"}. Nothing was saved.` });

    if (on === "deal") {
      const f = await findDeal(c, about);
      if (!("deal" in f)) return f;
      const { data, error } = await c.db.from("opportunity_notes").insert({ org_id: c.orgId, opportunity_id: f.deal.id, body, created_by: by }).select("id").maybeSingle();
      return error || !data ? failed(error) : { ok: true, line: `Note saved on the deal "${f.deal.name ?? about}".` };
    }
    let project: { id: string; name: string } | null = null;
    if (on !== "project") {
      const people = await searchContacts(c.db, c.orgId, about, 5);
      if (people.length === 1) {
        const { data, error } = await c.db.from("contact_notes").insert({ contact_id: people[0].id, user_id: by, content: body }).select("id").maybeSingle();
        return error || !data ? failed(error) : { ok: true, line: `Note saved on ${people[0].name}'s record.`, detail: asDetail({ link: `/contacts/${people[0].id}` }) };
      }
      if (people.length > 1) return { ok: false, clarify: true, line: `Which ${about}: ${people.slice(0, 4).map(who).join(", ")}?` };
      if (on === "contact") return { ok: false, clarify: true, line: `I don't have a contact called "${about}".` };
    }
    const p = await oneProject(c, about);
    if ("project" in p) project = { id: p.project.id, name: p.project.name };
    else if (/^Which project/.test(p.line)) return p;
    if (!project) return { ok: false, clarify: true, line: `I can't find a ${on === "project" ? "project" : "contact or project"} called "${about}". Who is it about?` };
    const { data, error } = await c.db.from("project_notes").insert({ org_id: c.orgId, project_id: project.id, body, created_by: by }).select("id").maybeSingle();
    return error || !data ? failed(error) : { ok: true, line: `Note saved on ${project.name}.`, detail: asDetail({ link: `/projects/${project.id}` }) };
  },
};

// ── tasks ───────────────────────────────────────────────────────────────────────────────────

type TaskKind = "personal" | "contact" | "project";
interface TaskRef { kind: TaskKind; id: string; title: string; due: string | null; assignee: string | null; done: boolean }
const TASK_TABLE = { personal: "calendar_tasks", contact: "contact_tasks", project: "project_tasks" } as const;
const OPEN = { personal: ["pending", "in_progress"], contact: ["pending", "in_progress"], project: ["todo", "in_progress", "in_review"] } as const;

/** Tasks in this org whose title contains every word of q. Open ones unless includeDone. */
export async function findTasks(c: OwnerCtx, q: string, includeDone = false): Promise<TaskRef[]> {
  const words = q.toLowerCase().split(/\s+/).map(like).filter(Boolean);
  if (!words.length) return [];
  const probe = `%${[...words].sort((x, y) => y.length - x.length)[0]}%`;
  const [cal, con, prj] = await Promise.all([
    c.db.from("calendar_tasks").select("id, title, due_at_utc, user_id, status").eq("org_id", c.orgId).ilike("title", probe).limit(40),
    c.db.from("contact_tasks").select("id, title, due_date, assigned_to_user_id, status, contact_id").ilike("title", probe).limit(40),
    c.db.from("project_tasks").select("id, title, due_date, assigned_user_id, status").eq("org_id", c.orgId).ilike("title", probe).limit(40),
  ]);
  // contact_tasks carries no org column: keep only tasks whose contact is in this org.
  let conRows = (con.data ?? []) as Json[];
  if (conRows.length) {
    const { data } = await c.db.from("contacts").select("id").eq("organization_id", c.orgId).in("id", [...new Set(conRows.map((r) => r.contact_id))]);
    const mine = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
    conRows = conRows.filter((r) => mine.has(r.contact_id));
  }
  const all: TaskRef[] = [
    ...((cal.data ?? []) as Json[]).map((t) => ({ kind: "personal" as const, id: t.id, title: t.title, due: t.due_at_utc ?? null, assignee: t.user_id ?? null, done: !(OPEN.personal as readonly string[]).includes(t.status) })),
    ...conRows.map((t) => ({ kind: "contact" as const, id: t.id, title: t.title, due: t.due_date ?? null, assignee: t.assigned_to_user_id ?? null, done: !(OPEN.contact as readonly string[]).includes(t.status) })),
    ...((prj.data ?? []) as Json[]).map((t) => ({ kind: "project" as const, id: t.id, title: t.title, due: t.due_date ?? null, assignee: t.assigned_user_id ?? null, done: !(OPEN.project as readonly string[]).includes(t.status) })),
  ];
  return all.filter((t) => (includeDone || !t.done) && words.every((w) => String(t.title).toLowerCase().includes(w)));
}

const updateTask: OwnerTool = {
  name: "update_task",
  ownerOnly: true,
  description: "Change an existing task (his own, or anyone's in the OS). task = words from its title. action: complete, reopen, cancel, or update (give any of due, assignee, title, priority). due is ISO 8601 with offset, or a bare date. assignee is a team member's name, or 'me'.",
  input_schema: {
    type: "object", required: ["task", "action"],
    properties: {
      task: { type: "string", description: "Words from the task's title" },
      action: { type: "string", enum: ["complete", "reopen", "cancel", "update"] },
      due: { type: "string" }, assignee: { type: "string" }, title: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
    },
  },
  async run(c, a) {
    const q = str(a.task), action = str(a.action);
    if (!q) return { ok: false, clarify: true, line: "Which task?" };
    if (!["complete", "reopen", "cancel", "update"].includes(action)) return { ok: false, clarify: true, line: "Should I complete it, reopen it, cancel it, or change something on it?" };
    let found = await findTasks(c, q, action === "reopen");
    if (action === "reopen") found = found.filter((t) => t.done);
    // "the proposal task" with several matches: his own first, then an exact title.
    if (found.length > 1) {
      const exact = found.filter((t) => t.title.toLowerCase() === q.toLowerCase());
      const mine = found.filter((t) => t.assignee === c.ownerUserId);
      if (exact.length === 1) found = exact; else if (mine.length === 1) found = mine;
    }
    if (!found.length) return { ok: false, clarify: true, line: `I can't find ${action === "reopen" ? "a finished" : "an open"} task matching "${q}". What's it called?` };
    if (found.length > 1) return { ok: false, clarify: true, line: `Which task: ${found.slice(0, 5).map((t) => `"${String(t.title).slice(0, 60)}" (${t.kind})`).join("; ")}?` };
    const t = found[0];
    const table = TASK_TABLE[t.kind];
    const nowISO = c.now().toISOString();
    const name = `"${String(t.title).slice(0, 80)}"`;
    const apply = async (patch: Json, line: string): Promise<ToolResult> => {
      const { data, error } = await c.db.from(table).update(patch).eq("id", t.id).select("id");
      if (error || !(data as unknown[] | null)?.length) return { ok: false, line: `I couldn't change ${name}: ${error?.message ?? "no row changed"}. Nothing was changed.` };
      return { ok: true, line };
    };

    if (action === "complete") {
      return await apply(t.kind === "personal" ? { status: "completed", completed: true, completed_at: nowISO } : { status: "completed", completed_at: nowISO }, `Marked ${name} done.`);
    }
    if (action === "reopen") {
      return await apply(t.kind === "personal" ? { status: "pending", completed: false, completed_at: null } : { status: t.kind === "project" ? "todo" : "pending", completed_at: null }, `Reopened ${name}.`);
    }
    if (action === "cancel") {
      if (t.kind !== "personal") return await apply({ status: "cancelled" }, `Cancelled ${name}.`);
      // The personal list has no cancelled state: a cancelled to-do is removed.
      const { data, error } = await c.db.from(table).delete().eq("id", t.id).select("id");
      if (error || !(data as unknown[] | null)?.length) return { ok: false, line: `I couldn't remove ${name}: ${error?.message ?? "no row changed"}. Nothing was changed.` };
      return { ok: true, line: `Removed ${name} from your list.` };
    }

    const patch: Json = {};
    const said: string[] = [];
    if (has(a, "due")) {
      const dateOnly = DATE_RE.test(str(a.due));
      const due = new Date(dateOnly ? `${str(a.due)}T21:00:00Z` : str(a.due));
      if (Number.isNaN(due.getTime())) return { ok: false, clarify: true, line: "When should it be due?" };
      const day = dateOnly ? str(a.due) : due.toLocaleDateString("en-CA", { timeZone: tzOf(c) });
      if (t.kind === "personal") patch.due_at_utc = due.toISOString(); else patch.due_date = t.kind === "project" ? day : due.toISOString();
      said.push(`due ${t.kind === "project" || dateOnly ? day : fmtWhen(c, due)}`);
    }
    if (has(a, "assignee")) {
      const u = await resolveUser(c, str(a.assignee));
      if ("clarify" in u) return { ok: false, clarify: true, line: u.clarify };
      if (t.kind === "personal") {
        const cal = await personalCalendarId(c, u.user.id);
        if (!cal) return { ok: false, line: `I couldn't move ${name}: ${u.user.name} has no personal task list in the OS. Nothing was changed.` };
        Object.assign(patch, { user_id: u.user.id, calendar_id: cal });
      } else patch[t.kind === "contact" ? "assigned_to_user_id" : "assigned_user_id"] = u.user.id;
      said.push(`assigned to ${u.user.id === c.ownerUserId ? "you" : u.user.name}`);
    }
    if (has(a, "title")) { patch.title = str(a.title).slice(0, 300); said.push(`renamed "${patch.title.slice(0, 60)}"`); }
    if (has(a, "priority")) {
      const p = str(a.priority) === "urgent" && t.kind !== "project" ? "high" : str(a.priority);
      if (["low", "medium", "high", "urgent"].includes(p)) { patch.priority = p; said.push(`priority ${p}`); }
    }
    if (!said.length) return { ok: false, clarify: true, line: `What should I change on ${name}?` };
    return await apply(patch, `Updated ${name}: ${said.join(", ")}.`);
  },
};

// ── projects ────────────────────────────────────────────────────────────────────────────────

const createProject: OwnerTool = {
  name: "create_project",
  ownerOnly: true,
  description: "Open a new delivery project. pipeline: Engineering (default) or CAIO Engagements. client is the contact it is for. The pipeline's playbook, if it has one, starts with the project (its first-stage steps go to the agents). For a sales opportunity use create_deal instead.",
  input_schema: {
    type: "object", required: ["name"],
    properties: {
      name: { type: "string" }, client: { type: "string", description: "Contact name or email" }, pipeline: { type: "string" },
      description: { type: "string" }, target_date: { type: "string", description: "YYYY-MM-DD" },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] }, brand: { type: "string", enum: BRAND_KEYS },
    },
  },
  async run(c, a) {
    const name = str(a.name).slice(0, 200);
    if (!name) return { ok: false, clarify: true, line: "What should the project be called?" };
    if (!c.ownerUserId) return { ok: false, line: "I couldn't open the project: the owner's OS user isn't configured (OWNER_USER_ID)." };
    const { data: same } = await c.db.from("projects").select("id, name").eq("org_id", c.orgId).ilike("name", like(name)).limit(1);
    if (((same ?? []) as Json[]).length) return { ok: false, clarify: true, line: `There's already a project called "${(same as Json[])[0].name}". Different name, or did you mean that one?` };
    let contact: Person | null = null;
    if (str(a.client)) {
      const f = await oneContact(c, str(a.client));
      if (!("person" in f)) return f;
      contact = f.person;
    }
    const { data: pipes } = await c.db.from("project_pipelines").select("id, name").eq("org_id", c.orgId);
    const pipe = pickStage((pipes ?? []) as { id: string; name: string }[], str(a.pipeline) || "Engineering");
    if (!pipe || Array.isArray(pipe)) return { ok: false, clarify: true, line: `Which pipeline: ${((pipes ?? []) as Json[]).map((p) => p.name).join(", ") || "none are set up"}?` };
    const { data: stages } = await c.db.from("project_stages").select("id, name, sort_order").eq("pipeline_id", pipe.id).order("sort_order").limit(1);
    const first = ((stages ?? []) as Json[])[0];
    if (!first) return { ok: false, line: `The ${pipe.name} pipeline has no stages. Nothing was created.` };
    const { data, error } = await c.db.from("projects").insert({
      org_id: c.orgId, pipeline_id: pipe.id, stage_id: first.id, name, contact_id: contact?.id ?? null, description: str(a.description) || null,
      status: "active", priority: ["low", "medium", "high", "urgent"].includes(str(a.priority)) ? str(a.priority) : "medium",
      target_end_date: DATE_RE.test(str(a.target_date)) ? str(a.target_date) : null,
      ...(isBrand(str(a.brand)) ? { brand: str(a.brand) } : {}),
      assigned_user_id: c.ownerUserId, created_by: c.ownerUserId,
    }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't open the project: ${error?.message ?? "no row returned"}. Nothing was created.` };
    const id = (data as Json).id as string;
    // Only say a play started if one did.
    const { data: runs } = await c.db.from("playbook_runs").select("id").eq("subject_id", id).limit(1);
    const started = ((runs ?? []) as Json[]).length > 0;
    return { ok: true, line: `Opened the project "${name}"${contact ? ` for ${contact.name}` : ""} in ${pipe.name} (${first.name}).${started ? " Its playbook has started." : ""}`, detail: asDetail({ id, link: `/projects/${id}` }) };
  },
};

const updateProject: OwnerTool = {
  name: "update_project",
  ownerOnly: true,
  description: "Change a project's status (active, on_hold, completed, cancelled), priority, target date, risk level, progress percent or description. To move it between stages use move_project.",
  input_schema: {
    type: "object", required: ["project"],
    properties: {
      project: { type: "string", description: "Project name or id" },
      status: { type: "string", enum: ["active", "on_hold", "completed", "cancelled"] },
      priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      target_date: { type: "string", description: "YYYY-MM-DD" },
      risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
      progress: { type: "integer", minimum: 0, maximum: 100 }, description: { type: "string" },
    },
  },
  async run(c, a) {
    const f = await oneProject(c, str(a.project));
    if (!("project" in f)) return f;
    const patch: Json = {};
    const said: string[] = [];
    if (["active", "on_hold", "completed", "cancelled"].includes(str(a.status))) { patch.status = str(a.status); said.push(`status ${str(a.status).replace("_", " ")}`); }
    if (["low", "medium", "high", "urgent"].includes(str(a.priority))) { patch.priority = str(a.priority); said.push(`priority ${patch.priority}`); }
    if (has(a, "target_date")) {
      if (!DATE_RE.test(str(a.target_date))) return { ok: false, clarify: true, line: "What's the new target date?" };
      patch.target_end_date = str(a.target_date); said.push(`target ${patch.target_end_date}`);
    }
    if (["low", "medium", "high", "critical"].includes(str(a.risk))) { patch.risk_level = str(a.risk); said.push(`risk ${patch.risk_level}`); }
    if (typeof a.progress === "number" && a.progress >= 0 && a.progress <= 100) { patch.progress_percent = Math.round(a.progress); said.push(`progress ${patch.progress_percent}%`); }
    if (has(a, "description")) { patch.description = str(a.description).slice(0, 8000); said.push("description updated"); }
    if (!said.length) return { ok: false, clarify: true, line: `What should I change on ${f.project.name}?` };
    const { data, error } = await c.db.from("projects").update(patch).eq("org_id", c.orgId).eq("id", f.project.id).select("id");
    if (error || !(data as unknown[] | null)?.length) return { ok: false, line: `I couldn't update ${f.project.name}: ${error?.message ?? "no row changed"}. Nothing was changed.` };
    return { ok: true, line: `Updated ${f.project.name}: ${said.join(", ")}.`, detail: asDetail({ link: `/projects/${f.project.id}` }) };
  },
};

// ── bookings ────────────────────────────────────────────────────────────────────────────────

const changeBooking: OwnerTool = {
  name: "change_booking",
  ownerOnly: true,
  description: "Cancel or move a meeting that was booked through the OS booking pages (capability briefings, discovery calls...). The guest is emailed and the calendar event follows. meeting = the guest's name and/or the meeting type; on (YYYY-MM-DD) narrows it to a day. For reschedule give new_start as ISO 8601 with offset (the length stays the same). Meetings that are only on his Google or Outlook calendar are not bookings: hand those to FRIDAY.",
  input_schema: {
    type: "object", required: ["action"],
    properties: {
      action: { type: "string", enum: ["cancel", "reschedule"] },
      meeting: { type: "string", description: "Guest name and/or meeting type" }, on: { type: "string", description: "YYYY-MM-DD" },
      new_start: { type: "string" }, reason: { type: "string" },
    },
  },
  async run(c, a) {
    const action = str(a.action);
    if (action !== "cancel" && action !== "reschedule") return { ok: false, clarify: true, line: "Cancel it or move it?" };
    if (!c.changeBooking) return { ok: false, line: "I can't change bookings from here. Nothing was changed." };
    const { data } = await c.db.from("appointments").select("id, start_at_utc, end_at_utc, contact_id, appointment_type_id, cancel_token, reschedule_token")
      .eq("org_id", c.orgId).eq("status", "scheduled").gte("start_at_utc", c.now().toISOString()).order("start_at_utc").limit(200);
    let rows = (data ?? []) as Json[];
    if (!rows.length) return { ok: false, line: "There are no upcoming bookings in the OS." };
    const cids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))], tids = [...new Set(rows.map((r) => r.appointment_type_id).filter(Boolean))];
    const names = new Map<string, string>(), types = new Map<string, string>();
    if (cids.length) for (const p of ((await c.db.from("contacts").select("id, first_name, last_name, company").in("id", cids)).data ?? []) as Json[]) names.set(p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || p.company || "a guest");
    if (tids.length) for (const t of ((await c.db.from("appointment_types").select("id, name").in("id", tids)).data ?? []) as Json[]) types.set(t.id, t.name);
    const label = (r: Json) => `${fmtWhen(c, new Date(r.start_at_utc))} ${types.get(r.appointment_type_id) ?? "booking"}${names.get(r.contact_id) ? ` with ${names.get(r.contact_id)}` : ""}`;
    if (DATE_RE.test(str(a.on))) rows = rows.filter((r) => new Date(r.start_at_utc).toLocaleDateString("en-CA", { timeZone: tzOf(c) }) === str(a.on));
    const words = str(a.meeting).toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !["the", "with", "my", "meeting", "call", "booking", "appointment"].includes(w));
    if (words.length) rows = rows.filter((r) => words.every((w) => `${names.get(r.contact_id) ?? ""} ${types.get(r.appointment_type_id) ?? ""}`.toLowerCase().includes(w)));
    if (!rows.length) return { ok: false, clarify: true, line: "I can't find an upcoming booking matching that. Who is it with, and what day?" };
    if (rows.length > 1) return { ok: false, clarify: true, line: `Which one: ${rows.slice(0, 5).map(label).join("; ")}${rows.length > 5 ? `; and ${rows.length - 5} more` : ""}?` };
    const r = rows[0];

    if (action === "cancel") {
      const res = await c.changeBooking({ action: "cancel", token: r.cancel_token, reason: str(a.reason) || undefined }).catch((e) => ({ ok: false, error: String((e as Error).message) }));
      if (!res.ok) return { ok: false, line: `I couldn't cancel ${label(r)}: ${String(res.error ?? "unknown error").slice(0, 160)}. Nothing was changed.` };
      return { ok: true, line: `Cancelled ${label(r)}. The guest gets the cancellation email.` };
    }
    const start = new Date(str(a.new_start));
    if (Number.isNaN(start.getTime())) return { ok: false, clarify: true, line: `Move ${label(r)} to when?` };
    if (start.getTime() < c.now().getTime()) return { ok: false, clarify: true, line: "That time is in the past. When did you mean?" };
    const end = new Date(start.getTime() + (Date.parse(r.end_at_utc) - Date.parse(r.start_at_utc)));
    const res = await c.changeBooking({ action: "reschedule", token: r.reschedule_token, startISO: start.toISOString(), endISO: end.toISOString() }).catch((e) => ({ ok: false, error: String((e as Error).message) }));
    if (!res.ok) return { ok: false, line: `I couldn't move ${label(r)}: ${String(res.error ?? "unknown error").slice(0, 160)}. Nothing was changed.` };
    return { ok: true, line: `Moved ${label(r)} to ${fmtWhen(c, start)}. The guest gets the new time by email.` };
  },
};

// ── Harvey ──────────────────────────────────────────────────────────────────────────────────

/** Harvey reports about once a minute; older than this and the numbers may be stale. */
export const HARVEY_STALE_MS = 15 * 60_000;

const harveyStatus: OwnerTool = {
  name: "harvey_status",
  readOnly: true, ownerOnly: true,
  description: "What Harvey (the outbound prospecting agent) is doing: running or paused, emails/texts/LinkedIn sent today against the caps, prospects by stage, drafts waiting for the owner's review, open reply conversations.",
  input_schema: { type: "object", properties: {} },
  async run(c) {
    const { data } = await c.db.from("harvey_status").select("snapshot, updated_at").eq("org_id", c.orgId).maybeSingle();
    const row = data as { snapshot: Json | null; updated_at: string } | null;
    if (!row?.snapshot) return { ok: true, line: "Harvey has never reported to the OS, so I can't see what he's doing." };
    const s = row.snapshot;
    const stale = c.now().getTime() - Date.parse(row.updated_at) > HARVEY_STALE_MS;
    const state = s.paused ? `paused${s.paused_reason ? ` (${s.paused_reason})` : ""}` : s.running ? "running" : "not running";
    const sent = `${s.email?.sent_today ?? 0}/${s.email?.daily_cap ?? "?"} emails today`;
    const review = Number(s.pending_review ?? 0);
    return {
      ok: true,
      line: `Harvey is ${state}${stale ? `, but he last reported ${fmtWhen(c, new Date(row.updated_at))}, so this may be out of date` : ""}: ${sent}, ${review} draft${review === 1 ? "" : "s"} waiting for your review, ${s.open_conversations ?? 0} open conversation${Number(s.open_conversations ?? 0) === 1 ? "" : "s"}.`,
      detail: asDetail({
        reported_at: row.updated_at, paused: !!s.paused, paused_reason: s.paused_reason || null, quiet_hours: !!s.quiet_hours, email: s.email, sms: s.sms,
        linkedin: s.linkedin ? { mode: s.linkedin.mode, sent_today: s.linkedin.sent_today, waiting_for_owner: (s.linkedin.queue ?? []).length, tripped_until: s.linkedin.tripped_until } : null,
        limits: s.safety, prospects: s.prospects, pending_review: review, approved_waiting: s.approved_waiting, open_conversations: s.open_conversations, link: "/harvey",
      }),
    };
  },
};

const harveyCommand: OwnerTool = {
  name: "harvey_command",
  ownerOnly: true,
  description: "Tell Harvey to pause (stop all outreach), resume, or sync_now (report to the OS right away). He picks the command up within about a minute.",
  input_schema: { type: "object", required: ["command"], properties: { command: { type: "string", enum: ["pause", "resume", "sync_now"] } } },
  async run(c, a) {
    const command = str(a.command);
    if (!["pause", "resume", "sync_now"].includes(command)) return { ok: false, clarify: true, line: "Pause Harvey, resume him, or have him sync?" };
    if (!c.ownerUserId) return { ok: false, line: "I couldn't send that to Harvey: the owner's OS user isn't configured (OWNER_USER_ID)." };
    const { data, error } = await c.db.from("harvey_commands").insert({ org_id: c.orgId, requested_by: c.ownerUserId, command, args: {} }).select("id").maybeSingle();
    if (error || !data) return { ok: false, line: `I couldn't send that to Harvey: ${error?.message ?? "no row returned"}.` };
    return { ok: true, line: `Told Harvey to ${command === "sync_now" ? "sync now" : command}. He picks it up within about a minute; it isn't done until he does.` };
  },
};

export const MANAGE_TOOLS: OwnerTool[] = [saveContact, addNote, updateTask, createProject, updateProject, changeBooking, harveyStatus, harveyCommand];
