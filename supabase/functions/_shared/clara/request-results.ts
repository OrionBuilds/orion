/**
 * Closing the loop on work Clara handed to another agent: tell the owner how it ended.
 *
 * Runs every minute (clara-request-results). Three jobs, all idempotent:
 *   1. a finished request (completed / failed / needs_input) the owner hasn't heard about is
 *      announced once, then marked notified;
 *   2. a request whose lease lapsed three times is failed outright (the agent stopped answering);
 *   3. a request still unclaimed after STALE_MINUTES gets one "nobody has picked this up" warning,
 *      because a queued task that silently never runs is exactly the failure to avoid.
 *
 * Requests the owner typed into an agent thread in Conversations (source.channel = 'agent_thread')
 * are answered IN that thread by the database (trg_agent_thread_request_progress marks them
 * notified as it posts), so job 1 only sees them if that post failed, and then texts as a fallback.
 * Their stale warning (job 3) is a note in the thread instead of a text.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { NotifyRequest, NotifyResult } from "./notify.ts";
import { warnThreadStale } from "./agent-thread.ts";

export const STALE_MINUTES = 30;

interface Req {
  id: string; org_id: string; title: string; kind: string; status: string;
  result_summary: string | null; error: string | null; created_at: string;
  source?: { channel?: string } | null;
}

const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function announcement(r: Pick<Req, "title" | "status" | "result_summary" | "error">): string {
  const t = `"${clip(r.title, 70)}"`;
  if (r.status === "completed") return `FRIDAY finished ${t}.${r.result_summary ? ` ${clip(r.result_summary, 280)}` : ""}`.trim();
  if (r.status === "needs_input") return `FRIDAY has a question on ${t}: ${clip(r.result_summary, 280) || "(no detail given)"} Reply with your answer and I'll pass it on.`;
  return `FRIDAY couldn't finish ${t}.${r.error ? ` ${clip(r.error, 240)}` : ""} Want me to try again or change the brief?`.trim();
}

export async function processRequestResults(
  db: SupabaseClient, d: { notify: (orgId: string, req: NotifyRequest) => Promise<NotifyResult>; now: () => Date },
): Promise<{ announced: number; failedStale: number; warned: number }> {
  const nowIso = d.now().toISOString();

  // 2. Dead leases: attempts exhausted.
  const { data: dead } = await db.from("agent_requests").update({
    status: "failed", error: "The assigned agent stopped responding after 3 attempts.", finished_at: nowIso, lease_expires_at: null, updated_at: nowIso,
  }).eq("status", "claimed").lt("lease_expires_at", nowIso).gte("attempt", 3).select("id");
  const failedStale = ((dead ?? []) as unknown[]).length;

  // 1. Announce finished work.
  const { data: done } = await db.from("agent_requests")
    .select("id, org_id, title, kind, status, result_summary, error, created_at")
    .is("notified_at", null).in("status", ["completed", "failed", "needs_input"]).order("finished_at").limit(20);
  let announced = 0;
  for (const r of (done ?? []) as Req[]) {
    const res = await d.notify(r.org_id, {
      kind: `agent_request.${r.status}`, priority: "critical", category: "revenue",
      text: announcement(r), dedupeKey: `agent-request:${r.id}:${r.status}`,
    }).catch(() => "failed" as NotifyResult);
    // Only mark told once the owner was actually reached (or it was already announced); otherwise retry next minute.
    if (res !== "failed") {
      await db.from("agent_requests").update({ notified_at: nowIso }).eq("id", r.id).is("notified_at", null);
      announced++;
    }
  }

  // 3. Unclaimed too long.
  const cutoff = new Date(d.now().getTime() - STALE_MINUTES * 60_000).toISOString();
  const { data: stale } = await db.from("agent_requests").select("id, org_id, title, kind, status, result_summary, error, created_at, source")
    .eq("status", "queued").lt("created_at", cutoff).limit(20);
  let warned = 0;
  for (const r of (stale ?? []) as Req[]) {
    if (r.source?.channel === "agent_thread") {
      if (await warnThreadStale(db, r.id, STALE_MINUTES, d.now()).catch(() => false)) warned++;
      continue;
    }
    const res = await d.notify(r.org_id, {
      kind: "agent_request.stale", priority: "critical", category: "production",
      text: `FRIDAY hasn't picked up "${clip(r.title, 70)}" in ${STALE_MINUTES} minutes. The runner may be down.`,
      dedupeKey: `agent-request:${r.id}:stale`,
    }).catch(() => "failed" as NotifyResult);
    if (res === "sms" || res === "email") warned++;
  }
  return { announced, failedStale, warned };
}
