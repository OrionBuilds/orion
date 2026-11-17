/**
 * Task deadline alerts (ported from CLARA's deadline-scan, now on project_tasks.due_date).
 *
 * Open tasks assigned to the owner that are overdue, due today or due tomorrow each get ONE owner
 * notification per bucket (dedupe key task-due:<task>:<bucket>), so a task nags at most three times
 * over its life. Priority is "normal": it is held for the next brief and never punches through quiet
 * hours. Owner-facing only; nothing here is sent to a client.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Env } from "./phones.ts";
import type { NotifyRequest } from "./notify.ts";

export const MAX_PER_RUN = 10;
const OPEN = ["todo", "in_progress", "in_review"];

export type Bucket = "overdue" | "today" | "tomorrow";

interface TaskRow { id: string; title: string; due_date: string; priority: string | null }

/** Pure: the org-local calendar date (YYYY-MM-DD) for an instant. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Pure: add whole days to a YYYY-MM-DD string. */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Pure: which bucket a due date falls in relative to today (null = not yet worth a nudge). */
export function bucketFor(due: string, today: string): Bucket | null {
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (due === addDays(today, 1)) return "tomorrow";
  return null;
}

const WHEN: Record<Bucket, string> = { overdue: "is overdue", today: "is due today", tomorrow: "is due tomorrow" };

/** Pure: the owner-facing line for one task. */
export function deadlineText(t: Pick<TaskRow, "title" | "due_date">, b: Bucket): string {
  return `Task "${t.title}" ${WHEN[b]} (due ${t.due_date}).`;
}

export async function scanTaskDeadlines(
  db: SupabaseClient, env: Env, d: { orgId: string; now: Date; notify: (r: NotifyRequest) => Promise<unknown> },
): Promise<{ alerted: number; skipped?: string }> {
  const owner = env.get("OWNER_USER_ID")?.trim();
  if (!owner) return { alerted: 0, skipped: "no owner user configured" };
  const tz = env.get("CLARA_TZ") || "America/New_York";
  const today = localDate(d.now, tz);
  const { data } = await db.from("project_tasks").select("id, title, due_date, priority")
    .eq("org_id", d.orgId).eq("assigned_user_id", owner).in("status", OPEN)
    .not("due_date", "is", null).lte("due_date", addDays(today, 1)).order("due_date").limit(100);
  let alerted = 0;
  for (const t of (data ?? []) as TaskRow[]) {
    if (alerted >= MAX_PER_RUN) break;
    const bucket = bucketFor(t.due_date, today);
    if (!bucket) continue;
    const res = await d.notify({ kind: "task.deadline", priority: "normal", text: deadlineText(t, bucket), dedupeKey: `task-due:${t.id}:${bucket}` });
    if (res !== "deduped") alerted++;
  }
  return { alerted };
}
