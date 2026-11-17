/**
 * weekly-client-update (ported from FRIDAY's weeklyUpdate.ts): every Friday afternoon each active client
 * with movement gets a short "here's your week" note drawn ONLY from the project task board.
 *
 * Delivery (no direct client sends): (1) a Project Update on the OS client portal (project_activity_log),
 * (2) the email as a DRAFT in the owner's approval queue (Clara's createApproval, client_visible tier);
 * Clara sends it from her mailbox only after he approves. Idempotent per (client, ISO week) through
 * friday_job_marks plus the portal source_ref and the approval's external_ref.
 *
 * Dropped from FRIDAY: the "open human-handoff escalation" skip (that store is local to the retired
 * FRIDAY app) and the Gmail-draft path.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "../clara/phones.ts";
import { createApproval } from "../clara/approvals.ts";
import type { Say } from "./json-llm.ts";
import type { Budget } from "./run-budget.ts";

const DAY = 86_400_000;
export const WEEK_MS = 7 * DAY;
export const COOLDOWN_MS = 6 * DAY;
export const CLIENT_ESTIMATE_MS = 20_000;
const MOVING = new Set(["in_progress", "in_review"]);

export interface Task { title: string; status: string; completed_at: string | null; updated_at: string }
export interface WeekWork { projects: { id: string; name: string }[]; shipped: Task[]; moving: Task[]; queued: Task[] }

/** ISO week key (YYYY-Www), the dedupe unit for one weekly update per client. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y0.getTime()) / DAY + 1) / 7)).padStart(2, "0")}`;
}

/** Pure: is it Friday at/after `hour` in the org's timezone? */
export function isWeeklyWindow(now: Date, tz: string, hour = 14): boolean {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return g("weekday") === "Fri" && Number(g("hour")) % 24 >= hour;
}

// Titles reach the client: scrub the internal task-board markers before they enter the prompt.
export function clientSafeTitle(title: string): string {
  return title.replace(/^\s*\[(?:QA|Fix(?:\s*R\d+)?)\]\s*/i, "").replace(/\s*—?\s*(issues from QA|failing checks)\s*—\s*/i, " — ").trim();
}

const INTERNAL_MARKERS = /\[(?:QA|Fix(?:\s*R\d+)?)\]|VERDICT:|\bauto-?merge\b|\bqa_testing\b|\brevisions\b|\bTier\s*\d\b/i;
const PLACEHOLDER = /\{[a-z0-9_ .-]+\}|\[[a-z0-9_ .-]+\]|\bTBD\b|\blorem\b|X{3,}/i;

/** Deterministic QA the fix pass must satisfy. */
export function weeklyUpdateIssues(text: string): string[] {
  const issues: string[] = [];
  if (!text || text.trim().length < 120) issues.push("update is too thin (<120 chars)");
  if (text.length > 2200) issues.push("update is too long (>2200 chars)");
  if (INTERNAL_MARKERS.test(text)) issues.push("contains internal task-board jargon ([QA]/[Fix]/VERDICT/stage names)");
  if (PLACEHOLDER.test(text)) issues.push("contains a placeholder/template token");
  if (/\$\s?\d/.test(text)) issues.push("contains a dollar figure (status mail never quotes money)");
  return issues;
}

export function draftPrompt(clientName: string, work: WeekWork): { system: string; prompt: string } {
  const first = clientName.trim().split(/\s+/)[0] || "there";
  const facts = [
    `shipped this week (${work.shipped.length}): ${work.shipped.slice(0, 6).map((t) => clientSafeTitle(t.title)).join("; ") || "none"}`,
    `in motion (${work.moving.length}): ${work.moving.slice(0, 5).map((t) => clientSafeTitle(t.title)).join("; ") || "none"}`,
    `queued next (${work.queued.length}): ${work.queued.slice(0, 4).map((t) => clientSafeTitle(t.title)).join("; ") || "none"}`,
    `projects: ${work.projects.map((p) => p.name).join(", ")}`,
  ].join("\n");
  return {
    system:
      "You are FRIDAY, Technical Director at the company, writing a client's CASUAL weekly check-in email — 90 to 170 words, warm plain English." +
      " Rules: use ONLY the facts provided; never invent work, dates, or promises; never mention money, internal tools, agents, QA, or process jargon;" +
      " 2 short paragraphs, no headings or bullets; if the week was quiet say so honestly and point at what's queued; sign off as FRIDAY. Output the email BODY only.",
    prompt: `Client: ${clientName}\nFirst name: ${first}\n\nThis week on their account:\n${facts}\n\nWrite the email body now.`,
  };
}

/** Deterministic body if the model is down: a missing week is worse than a plain one. */
export function templateBody(clientName: string, work: WeekWork): string {
  const first = clientName.trim().split(/\s+/)[0] || "there";
  const list = (ts: Task[], n: number) => ts.slice(0, n).map((t) => clientSafeTitle(t.title)).join("; ");
  const parts = [`Hi ${first},\n\nHere is a quick look at ${work.projects.map((p) => p.name).join(" and ")} this week.`];
  if (work.shipped.length) parts.push(`We wrapped up: ${list(work.shipped, 6)}.`);
  if (work.moving.length) parts.push(`Currently in motion: ${list(work.moving, 5)}.`);
  if (work.queued.length) parts.push(`Coming up next: ${list(work.queued, 4)}.`);
  parts.push("Reply here if there is anything you would like us to prioritize or change.\n\nFRIDAY");
  return parts.join("\n\n");
}

export async function gatherWeek(db: SupabaseClient, contactId: string, now: Date): Promise<WeekWork> {
  const cutoff = new Date(now.getTime() - WEEK_MS).toISOString();
  const { data: ps } = await db.from("projects").select("id, name").eq("contact_id", contactId).eq("status", "active").limit(20);
  const projects = (ps ?? []) as { id: string; name: string }[];
  if (!projects.length) return { projects, shipped: [], moving: [], queued: [] };
  const { data: ts } = await db.from("project_tasks").select("title, status, completed_at, updated_at").in("project_id", projects.map((p) => p.id)).limit(500);
  const tasks = (ts ?? []) as Task[];
  return {
    projects,
    shipped: tasks.filter((t) => t.status === "completed" && (t.completed_at ?? t.updated_at ?? "") >= cutoff),
    moving: tasks.filter((t) => MOVING.has(t.status)),
    queued: tasks.filter((t) => t.status === "todo"),
  };
}

export interface WeeklyDeps { db: SupabaseClient; env: Env; say: Say; budget: Budget; now: Date; orgId: string; ownerUserId: string | null; enabled?: boolean }
export interface WeeklyResult { clients: number; queued: number; skipped: number; partial: boolean; skips: Record<string, number> }

async function recentlyDone(db: SupabaseClient, orgId: string, contactId: string, now: Date): Promise<boolean> {
  const { data } = await db.from("friday_job_marks").select("key, created_at").eq("org_id", orgId).eq("job", "weekly-client-update").like("key", `${contactId}:%`)
    .gte("created_at", new Date(now.getTime() - COOLDOWN_MS).toISOString()).limit(5);
  return ((data ?? []) as { key: string }[]).length > 0;
}

export async function runWeeklyUpdates(d: WeeklyDeps): Promise<WeeklyResult> {
  const out: WeeklyResult = { clients: 0, queued: 0, skipped: 0, partial: false, skips: {} };
  if (d.enabled === false) return out;
  const skip = (why: string) => { out.skipped++; out.skips[why] = (out.skips[why] ?? 0) + 1; };
  const week = isoWeek(d.now);
  const { data: cs } = await d.db.from("contacts").select("id, first_name, last_name, email, status").eq("org_id", d.orgId).eq("status", "active").limit(500);
  const contacts = (cs ?? []) as { id: string; first_name: string | null; last_name: string | null; email: string | null }[];
  // Only contacts that own an active project can have a weekly update.
  const { data: owners } = await d.db.from("projects").select("contact_id").eq("org_id", d.orgId).eq("status", "active").not("contact_id", "is", null).limit(500);
  const withProject = new Set(((owners ?? []) as { contact_id: string }[]).map((p) => p.contact_id));

  for (const c of contacts.filter((x) => withProject.has(x.id))) {
    if (!d.budget.canStart(CLIENT_ESTIMATE_MS)) { out.partial = true; break; }
    out.clients++;
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "there";
    if (await recentlyDone(d.db, d.orgId, c.id, d.now)) { skip("already done <6d"); continue; }
    const work = await gatherWeek(d.db, c.id, d.now);
    if (!work.projects.length || (work.shipped.length === 0 && work.moving.length === 0)) {
      skip("no activity this week"); continue;
    }

    const { system, prompt } = draftPrompt(name, work);
    let body = (await d.say({ system, prompt, timeoutMs: d.budget.timeout(20_000) })) ?? "";
    let issues = weeklyUpdateIssues(body);
    if (issues.length && body && d.budget.canStart(10_000)) {
      const fixed = await d.say({
        system: "You edit a client-facing status email to fix the listed violations while keeping its warmth and meaning. Return the corrected email body only.",
        prompt: `Email:\n${body}\n\nViolations to fix:\n- ${issues.join("\n- ")}\n\nReturn the corrected body only.`, timeoutMs: d.budget.timeout(15_000),
      });
      const fi = fixed ? weeklyUpdateIssues(fixed) : issues;
      if (fixed && fi.length <= issues.length) { body = fixed; issues = fi; }
    }
    if (!body) { body = templateBody(name, work); issues = weeklyUpdateIssues(body); }
    const subject = `This week on ${work.projects[0].name} — ${d.now.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;

    // 1. Portal post (idempotent on source_ref), first project that did not opt out.
    const ref = `weekly:${c.id}:${week}`;
    const portalProject = await pickPortalProject(d.db, work.projects);
    let portal = false;
    if (portalProject) {
      const { data: ex } = await d.db.from("project_activity_log").select("id").eq("project_id", portalProject).eq("event_type", "milestone").eq("payload->>source_ref", ref).limit(1);
      if ((ex as unknown[] | null)?.length) portal = true;
      else {
        const { error } = await d.db.from("project_activity_log").insert({
          org_id: d.orgId, project_id: portalProject, event_type: "milestone", summary: subject.slice(0, 200),
          payload: { source: "friday-cron", title: subject.slice(0, 200), detail: body.slice(0, 4000), source_ref: ref, kind: "content", is_live: false },
        });
        portal = !error;
        if (error) console.error(`[weekly-client-update] portal post failed: ${error.message}`);
      }
    }
    // 2. Email as an owner-approval draft (never a direct send).
    let drafted = false;
    if (c.email) {
      const a = await createApproval(d.db, {
        orgId: d.orgId, externalRef: ref, title: `Weekly update for ${name}`.slice(0, 200),
        description: `${subject}${issues.length ? ` (QA: ${issues.join(" · ").slice(0, 120)})` : ""}`,
        risk: "low", riskTier: "client_visible", contactId: c.id,
        draft: { kind: "email", to: [c.email], subject, body, contact_id: c.id },
      });
      drafted = Boolean(a.id);
    }
    if (!portal && !drafted) { skip("nothing could be delivered"); continue; }
    await d.db.from("friday_job_marks").upsert({ org_id: d.orgId, job: "weekly-client-update", key: `${c.id}:${week}`, created_at: d.now.toISOString() }, { onConflict: "org_id,job,key", ignoreDuplicates: true });
    out.queued++;
  }
  return out;
}

async function pickPortalProject(db: SupabaseClient, projects: { id: string }[]): Promise<string | null> {
  const { data } = await db.from("project_agent_meta").select("project_id, meta").eq("agent", "friday").in("project_id", projects.map((p) => p.id));
  const optOut = new Set(((data ?? []) as { project_id: string; meta: { portalUpdates?: unknown } | null }[]).filter((m) => m.meta?.portalUpdates === false).map((m) => m.project_id));
  return projects.find((p) => !optOut.has(p.id))?.id ?? null;
}
