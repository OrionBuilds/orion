/**
 * Stall check-ins (ported from FRIDAY's stallCheckin.ts, now Clara's).
 *
 * Every morning (09:00 org-local), for each active client who (a) has an email, (b) has an open
 * task on an active project, (c) hasn't written to us in STALL_DAYS, and (d) wasn't nudged in the
 * last COOLDOWN_DAYS: draft one warm paragraph that references ONE specific open item and asks if
 * there's anything to prioritize. The draft goes to the owner's approval queue and is only sent
 * from Clara's mailbox after he approves (approvals.deliverDecided). It is NEVER auto-sent: an
 * unanswered client conversation is not something to autopilot into.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import { createApproval } from "./approvals.ts";
import { names } from "./persona.ts";

export const STALL_DAYS = 14;
export const COOLDOWN_DAYS = 30;
export const MAX_PER_RUN = 5;
const DAY = 86_400_000;

export interface Candidate { contactId: string; name: string; email: string; projectName: string; openItem: string }
export interface Draft { subject: string; body: string }

/** Pure: 09:00 org-local hour? (Hourly cron, one run a day.) */
export function isNudgeHour(now: Date, tz: string, hour = 9): boolean {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(now)) % 24 === hour;
}

/** Deterministic fallback so a model outage never silently skips a client. */
export function templateDraft(env: Env, c: Candidate): Draft {
  const n = names(env);
  return {
    subject: `Checking in on ${c.projectName}`,
    body: `Hi ${c.name.split(" ")[0]},\n\nI wanted to check in on ${c.projectName}. We're currently working on "${c.openItem}" — is there anything you'd like us to prioritize, or anything that's changed on your end?\n\nJust reply here and I'll make sure the team sees it.\n\n— Clara, assistant at ${n.business}`,
  };
}

export async function findCandidates(db: SupabaseClient, orgId: string, now: Date): Promise<Candidate[]> {
  const { data: projects } = await db.from("projects").select("id, name, contact_id, status").eq("org_id", orgId).eq("status", "active").limit(200);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const p of (projects ?? []) as { id: string; name: string; contact_id: string | null }[]) {
    if (!p.contact_id || seen.has(p.contact_id)) continue;
    const { data: c } = await db.from("contacts").select("first_name, last_name, email, status").eq("id", p.contact_id).maybeSingle();
    const contact = c as { first_name: string | null; last_name: string | null; email: string | null; status: string } | null;
    if (!contact?.email || contact.status !== "active") continue;

    // (c) quiet: no inbound from them in STALL_DAYS
    const since = new Date(now.getTime() - STALL_DAYS * DAY).toISOString();
    const { count: recent } = await db.from("messages").select("id", { count: "exact", head: true }).eq("contact_id", p.contact_id).eq("direction", "inbound").gte("sent_at", since);
    if ((recent ?? 0) > 0) continue;

    // (d) not nudged lately
    const { count: nudged } = await db.from("workflow_approval_queue").select("id", { count: "exact", head: true })
      .eq("agent_slug", "clara").like("external_ref", `stall:${p.contact_id}:%`).gte("requested_at", new Date(now.getTime() - COOLDOWN_DAYS * DAY).toISOString());
    if ((nudged ?? 0) > 0) continue;

    // (b) something open to talk about
    const { data: tasks } = await db.from("project_tasks").select("title, status").eq("project_id", p.id).neq("status", "completed").neq("status", "cancelled").order("created_at").limit(1);
    const open = (tasks as { title: string }[] | null)?.[0];
    if (!open) continue;

    seen.add(p.contact_id);
    out.push({ contactId: p.contact_id, name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || contact.email, email: contact.email, projectName: p.name, openItem: open.title });
  }
  return out;
}

export async function runStallNudges(
  db: SupabaseClient, env: Env, d: { orgId: string; now: Date; ownerUserId: string | null; draft?: (c: Candidate) => Promise<Draft | null> },
): Promise<{ drafted: number; candidates: number }> {
  const cands = await findCandidates(db, d.orgId, d.now);
  let drafted = 0;
  for (const c of cands.slice(0, MAX_PER_RUN)) {
    const draft = (await d.draft?.(c).catch(() => null)) ?? templateDraft(env, c);
    const month = d.now.toISOString().slice(0, 7);
    const r = await createApproval(db, {
      orgId: d.orgId, externalRef: `stall:${c.contactId}:${month}`, title: `Check-in to ${c.name} (${c.projectName})`,
      description: `${c.name} hasn't written in ${STALL_DAYS}+ days and "${c.openItem}" is open. Approve to send from Clara's mailbox.`,
      draft: { kind: "email", to: [c.email], subject: draft.subject, body: draft.body, contact_id: c.contactId },
    });
    if (r.created) drafted++;
  }
  return { drafted, candidates: cands.length };
}
