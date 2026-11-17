/**
 * Motion (usemotion.com) task push. Motion's public API has tasks, projects and workspaces but no
 * meetings, transcripts or webhooks, so the OS only WRITES to it: meeting action items owned by the
 * owner become Motion tasks (Motion then schedules them on the owner's calendar).
 *
 * The key lives in integration_connections (key 'motion', sealed JSON {api_key, workspace_id?,
 * project_id?}) like every other API-key integration. Nothing here logs or returns the key.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { openSecret } from "./secrets.ts";

export const MOTION_BASE = "https://api.usemotion.com/v1";

export interface MotionCreds { apiKey: string; workspaceId: string | null; projectId: string | null }
export interface MotionTaskInput {
  name: string;
  description?: string;
  dueDate?: string | null;
  priority?: "ASAP" | "HIGH" | "MEDIUM" | "LOW";
}
export type MotionFetch = (url: string, init: RequestInit) => Promise<Response>;

export class MotionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call(creds: Pick<MotionCreds, "apiKey">, method: string, path: string, body?: unknown, f: MotionFetch = fetch) {
  const res = await f(`${MOTION_BASE}${path}`, {
    method,
    headers: { "X-API-Key": creds.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? text.slice(0, 200) ?? res.statusText;
    throw new MotionError(`Motion ${res.status}: ${msg || res.statusText}`, res.status);
  }
  return data;
}

/** Workspaces the key can see. Also the cheapest "is this key valid" probe. */
export async function listMotionWorkspaces(apiKey: string, f: MotionFetch = fetch): Promise<{ id: string; name: string }[]> {
  const data = await call({ apiKey }, "GET", "/workspaces", undefined, f) as { workspaces?: { id: string; name: string }[] } | null;
  return (data?.workspaces ?? []).filter((w) => w?.id);
}

/** Motion wants ISO 8601; a bare date from the digest ("2026-11-14") becomes end of that day UTC. */
export function motionDueDate(due: string | null | undefined): string | null {
  if (!due) return null;
  const s = due.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function createMotionTask(
  creds: MotionCreds & { workspaceId: string },
  task: MotionTaskInput,
  f: MotionFetch = fetch,
): Promise<{ id: string }> {
  const due = motionDueDate(task.dueDate);
  const body: Record<string, unknown> = {
    name: task.name.slice(0, 200),
    workspaceId: creds.workspaceId,
    ...(task.description ? { description: task.description } : {}),
    ...(task.priority ? { priority: task.priority } : {}),
    ...(creds.projectId ? { projectId: creds.projectId } : {}),
    ...(due ? { dueDate: due, duration: 30, autoScheduled: { deadlineType: "SOFT", schedule: "Work Hours" } } : {}),
  };
  try {
    return await call(creds, "POST", "/tasks", body, f) as { id: string };
  } catch (e) {
    // The workspace's default status may not allow auto-scheduling; the task is still worth having.
    if (due && e instanceof MotionError && e.status === 400) {
      delete body.autoScheduled;
      return await call(creds, "POST", "/tasks", body, f) as { id: string };
    }
    throw e;
  }
}

/** The org's Motion connection, or null when not connected / key unreadable. */
export async function getMotionCreds(db: SupabaseClient, orgId: string): Promise<MotionCreds | null> {
  const { data: integ } = await db.from("integrations").select("id").eq("org_id", orgId).eq("key", "motion").maybeSingle();
  if (!integ) return null;
  const { data: conn } = await db.from("integration_connections")
    .select("credentials_encrypted, status, account_info")
    .eq("integration_id", (integ as { id: string }).id).eq("org_id", orgId).eq("status", "connected").maybeSingle();
  if (!conn) return null;
  try {
    const raw = await openSecret((conn as { credentials_encrypted: string | null }).credentials_encrypted);
    if (!raw) return null;
    const c = JSON.parse(raw) as { api_key?: string; workspace_id?: string; project_id?: string };
    const apiKey = (c.api_key ?? "").trim();
    if (!apiKey) return null;
    const info = ((conn as { account_info: Record<string, unknown> | null }).account_info ?? {}) as { workspace_id?: string };
    return {
      apiKey,
      workspaceId: (c.workspace_id ?? "").trim() || info.workspace_id || null,
      projectId: (c.project_id ?? "").trim() || null,
    };
  } catch {
    return null;
  }
}

export async function itemKey(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase().replace(/\s+/g, " ").trim()));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface MeetingPushItem { item: string; why?: string; client?: string; project?: string; due?: string; costsMoney?: boolean }

/**
 * Push the owner's action items from one meeting. Idempotent per (meeting, item text): a claim row is
 * inserted first, so re-importing the same transcript never makes a second Motion task, and a failed
 * push releases its claim so the next import retries it. Never throws; returns counts.
 */
export async function pushMeetingItemsToMotion(
  db: SupabaseClient,
  orgId: string,
  meeting: { transcriptionId: string; title: string; shareUrl?: string | null },
  items: MeetingPushItem[],
  f: MotionFetch = fetch,
): Promise<{ pushed: number; skipped: number; failed: number; error?: string }> {
  const out = { pushed: 0, skipped: 0, failed: 0 } as { pushed: number; skipped: number; failed: number; error?: string };
  if (!items.length) return out;
  const creds = await getMotionCreds(db, orgId);
  if (!creds) return out;
  let workspaceId = creds.workspaceId;
  try {
    if (!workspaceId) workspaceId = (await listMotionWorkspaces(creds.apiKey, f))[0]?.id ?? null;
  } catch (e) {
    return { ...out, failed: items.length, error: (e as Error).message };
  }
  if (!workspaceId) return { ...out, failed: items.length, error: "Motion key has no workspace" };

  for (const it of items) {
    const key = await itemKey(it.item);
    const { data: claim } = await db.from("meeting_motion_tasks")
      .upsert({ org_id: orgId, meeting_transcription_id: meeting.transcriptionId, item_key: key },
        { onConflict: "meeting_transcription_id,item_key", ignoreDuplicates: true })
      .select("id");
    if (!claim || claim.length === 0) { out.skipped++; continue; }
    try {
      const lines = [
        it.why ? it.why : null,
        it.client ? `Client: ${it.client}` : null,
        it.project ? `Project: ${it.project}` : null,
        it.costsMoney ? "Flag: likely costs money." : null,
        `From meeting: ${meeting.title}${meeting.shareUrl ? ` (${meeting.shareUrl})` : ""}`,
      ].filter(Boolean);
      const task = await createMotionTask({ ...creds, workspaceId }, {
        name: it.item, description: lines.join("\n\n"), dueDate: it.due ?? null, priority: it.costsMoney ? "HIGH" : "MEDIUM",
      }, f);
      await db.from("meeting_motion_tasks").update({ motion_task_id: task.id, motion_workspace_id: workspaceId })
        .eq("meeting_transcription_id", meeting.transcriptionId).eq("item_key", key);
      out.pushed++;
    } catch (e) {
      out.failed++;
      out.error = (e as Error).message;
      await db.from("meeting_motion_tasks").delete()
        .eq("meeting_transcription_id", meeting.transcriptionId).eq("item_key", key);
    }
  }
  return out;
}
