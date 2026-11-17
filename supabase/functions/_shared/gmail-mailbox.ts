/**
 * Gmail mailboxes of one OS user: the per-connection plumbing the Gmail functions share.
 *
 * A mailbox is one Google connection (google_oauth_master row) that also has a gmail_oauth_tokens row. Everything the sync
 * pipeline keeps per mailbox (history id, watch, lock, jobs) is keyed by the connection id. Rows written before
 * `connection_id` existed (NULL) belong to the user's primary account.
 *
 * Works on both schemas of the two-step rollout: nothing here relies on a unique constraint on connection_id; state rows are
 * found by select, then updated by their own id or inserted with the connection id.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  getGoogleAccessToken, listGoogleConnections, pickGoogleConnection, type ConnectionSelector,
} from "./google-connections.ts";

type Row = Record<string, any>;

export interface GmailMailbox { connectionId: string; userId: string; orgId: string; email: string; isPrimary: boolean }

/** A request named an account that is not the caller's (status 403) or no Gmail is connected at all (400). */
export class MailboxSelectError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Pure choice among a user's mailboxes: by connection id, else email, else the primary. A named account the user lacks gives null. */
export function pickMailbox(mailboxes: GmailMailbox[], sel: ConnectionSelector = {}): GmailMailbox | null {
  const p = pickGoogleConnection(mailboxes.map((m) => ({ id: m.connectionId, email: m.email, is_primary: m.isPrimary })), sel);
  return p ? mailboxes.find((m) => m.connectionId === p.id) ?? null : null;
}

/** Every Gmail mailbox the user has connected in this org, primary first. */
export async function listGmailMailboxes(db: SupabaseClient, userId: string, orgId: string): Promise<GmailMailbox[]> {
  const conns = await listGoogleConnections(db, userId);
  const { data } = await db.from("gmail_oauth_tokens").select("connection_id, email").eq("organization_id", orgId).eq("user_id", userId);
  const toks = (data ?? []) as Array<{ connection_id: string | null; email: string | null }>;
  const linked = new Set<string>();
  for (const t of toks) {
    if (t.connection_id) { linked.add(t.connection_id); continue; }
    // legacy row written before connection_id existed: its own address if that is one of the accounts, else the primary
    const byEmail = conns.find((c) => c.email.toLowerCase() === String(t.email ?? "").toLowerCase());
    const owner = byEmail ?? conns.find((c) => c.is_primary) ?? conns[0];
    if (owner) linked.add(owner.id);
  }
  return conns.filter((c) => linked.has(c.id)).map((c) => ({ connectionId: c.id, userId, orgId, email: c.email, isPrimary: c.is_primary }));
}

/** One mailbox of the user (default: the primary); null when it is not theirs / not a Gmail mailbox. */
export async function resolveGmailMailbox(db: SupabaseClient, userId: string, orgId: string, sel: ConnectionSelector = {}): Promise<GmailMailbox | null> {
  return pickMailbox(await listGmailMailboxes(db, userId, orgId), sel);
}

/** A valid access token for this mailbox: refreshes and stores ONLY this connection's rows; invalid_grant flips only this connection. */
export function getMailboxToken(db: SupabaseClient, mb: Pick<GmailMailbox, "userId" | "connectionId">): Promise<string> {
  return getGoogleAccessToken(db, mb.userId, { connectionId: mb.connectionId });
}

// ── sync state (history id, watch, lock) per mailbox ────────────────────────────────────────────

/** The mailbox's gmail_sync_state row; a legacy row without a connection id is the primary's. */
export async function findSyncState(db: SupabaseClient, mb: GmailMailbox): Promise<Row | null> {
  const { data } = await db.from("gmail_sync_state").select("*").eq("organization_id", mb.orgId).eq("user_id", mb.userId);
  const rows = (data ?? []) as Row[];
  return rows.find((r) => r.connection_id === mb.connectionId) ?? (mb.isPrimary ? rows.find((r) => !r.connection_id) ?? null : null);
}

/** Create or update the mailbox's sync state (a legacy row is adopted and stamped with the connection id). False when the write failed. */
export async function saveSyncState(db: SupabaseClient, mb: GmailMailbox, patch: Row): Promise<boolean> {
  const row = await findSyncState(db, mb);
  const { error } = row
    ? await db.from("gmail_sync_state").update({ ...patch, connection_id: mb.connectionId }).eq("id", row.id)
    : await db.from("gmail_sync_state").insert({ organization_id: mb.orgId, user_id: mb.userId, connection_id: mb.connectionId, ...patch });
  if (error) console.error("[gmail] sync state write failed:", error.message);
  return !error;
}

/** Take this mailbox's sync lock (idle -> syncing). False when another run holds it or there is no state yet. */
export async function claimSyncLock(db: SupabaseClient, mb: GmailMailbox): Promise<boolean> {
  const row = await findSyncState(db, mb);
  if (!row) return false;
  const { data } = await db.from("gmail_sync_state")
    .update({ sync_status: "syncing", connection_id: mb.connectionId, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("sync_status", "idle").select("id").maybeSingle();
  return Boolean(data);
}

/** The mailbox a gmail_sync_state row is for (a legacy row without a connection id is the user's primary); null when it no longer exists. */
export async function mailboxForState(db: SupabaseClient, state: Row): Promise<GmailMailbox | null> {
  const mbs = await listGmailMailboxes(db, state.user_id, state.organization_id);
  return state.connection_id ? mbs.find((m) => m.connectionId === state.connection_id) ?? null : mbs.find((m) => m.isPrimary) ?? mbs[0] ?? null;
}

// ── jobs ───────────────────────────────────────────────────────────────────────────────────────

/** Does a job (or state row) with this connection id belong to the mailbox? NULL = the primary's. */
export const belongsToMailbox = (rowConnectionId: string | null | undefined, mb: Pick<GmailMailbox, "connectionId" | "isPrimary">): boolean =>
  rowConnectionId === mb.connectionId || (!rowConnectionId && mb.isPrimary);

/** Queue a sync job for one mailbox. */
export async function enqueueMailboxJob(db: SupabaseClient, mb: GmailMailbox, jobType: string, extra: Row = {}): Promise<boolean> {
  const { error } = await db.from("gmail_sync_jobs").insert({
    organization_id: mb.orgId, user_id: mb.userId, connection_id: mb.connectionId, job_type: jobType, status: "queued", run_at: new Date().toISOString(), ...extra,
  });
  if (error) console.error("[gmail] enqueue failed:", error.message);
  return !error;
}

/** Mark the running first-sync job(s) of this mailbox done. */
export async function markInitialJobsDone(db: SupabaseClient, mb: GmailMailbox): Promise<void> {
  const { data } = await db.from("gmail_sync_jobs").select("id, connection_id").eq("organization_id", mb.orgId).eq("user_id", mb.userId).eq("job_type", "initial").eq("status", "running");
  const now = new Date().toISOString();
  for (const j of (data ?? []) as Array<{ id: string; connection_id: string | null }>) {
    if (belongsToMailbox(j.connection_id, mb)) await db.from("gmail_sync_jobs").update({ status: "done", updated_at: now }).eq("id", j.id);
  }
}

/**
 * Queue an incremental job for every mailbox that finished its first sync and has none in flight. Returns how many were queued.
 * A state row or job without a connection id counts for that user's primary mailbox.
 */
export async function enqueueDueIncrementalJobs(db: SupabaseClient, delayMs = 5 * 60_000): Promise<number> {
  const { data: states } = await db.from("gmail_sync_state").select("organization_id, user_id, connection_id, history_id").eq("sync_status", "idle").not("history_id", "is", null);
  const cache = new Map<string, GmailMailbox[]>();
  let queued = 0;
  for (const s of (states ?? []) as Row[]) {
    const key = `${s.organization_id}:${s.user_id}`;
    if (!cache.has(key)) cache.set(key, await listGmailMailboxes(db, s.user_id, s.organization_id));
    const mbs = cache.get(key)!;
    const mb = s.connection_id ? mbs.find((m) => m.connectionId === s.connection_id) : mbs.find((m) => m.isPrimary) ?? mbs[0];
    if (!mb) continue;
    const { data: inflight } = await db.from("gmail_sync_jobs").select("id, connection_id")
      .eq("organization_id", s.organization_id).eq("user_id", s.user_id).eq("job_type", "incremental").in("status", ["queued", "running", "retry"]);
    if (((inflight ?? []) as Row[]).some((j) => belongsToMailbox(j.connection_id, mb))) continue;
    if (await enqueueMailboxJob(db, mb, "incremental", { run_at: new Date(Date.now() + delayMs).toISOString() })) queued++;
  }
  return queued;
}

/**
 * The mailbox a job runs on. A job with a connection id runs there (null when that account is gone). A legacy job without one
 * runs on the primary and is stamped with it; a legacy contact backfill is also queued for every other mailbox of the user,
 * because the contact's history lives in each of them.
 */
export async function resolveJobMailbox(db: SupabaseClient, job: Row): Promise<GmailMailbox | null> {
  const mbs = await listGmailMailboxes(db, job.user_id, job.organization_id);
  if (job.connection_id) return mbs.find((m) => m.connectionId === job.connection_id) ?? null;
  const primary = mbs.find((m) => m.isPrimary) ?? mbs[0];
  if (!primary) return null;
  await db.from("gmail_sync_jobs").update({ connection_id: primary.connectionId }).eq("id", job.id);
  if (job.job_type === "contact_backfill") {
    const email = String((job.payload as Row | null)?.email ?? "").toLowerCase();
    const { data } = await db.from("gmail_sync_jobs").select("connection_id, payload").eq("organization_id", job.organization_id).eq("user_id", job.user_id).eq("job_type", "contact_backfill");
    for (const other of mbs.filter((m) => m.connectionId !== primary.connectionId)) {
      const have = ((data ?? []) as Row[]).some((j) => j.connection_id === other.connectionId && String(j.payload?.email ?? "").toLowerCase() === email);
      if (!have) await enqueueMailboxJob(db, other, "contact_backfill", { payload: { email: (job.payload as Row).email, contact_id: (job.payload as Row).contact_id } });
    }
  }
  return primary;
}

// ── push notifications ──────────────────────────────────────────────────────────────────────────

/**
 * The mailbox a Pub/Sub push is about: the connection whose address is `emailAddress` (case-insensitive, org-wide). When two OS
 * users share the address the oldest connection wins (as before); `candidates` says how many there were.
 */
export async function mapPushToMailbox(db: SupabaseClient, emailAddress: string): Promise<{ mailbox: GmailMailbox; candidates: number } | null> {
  const want = emailAddress.trim().toLowerCase();
  const { data } = await db.from("gmail_oauth_tokens").select("organization_id, user_id, connection_id, email, created_at").ilike("email", emailAddress.trim()).order("created_at", { ascending: true });
  const rows = ((data ?? []) as Row[]).filter((r) => String(r.email ?? "").toLowerCase() === want);
  for (const r of rows) {
    const mbs = await listGmailMailboxes(db, r.user_id, r.organization_id);
    const mailbox = r.connection_id ? mbs.find((m) => m.connectionId === r.connection_id) : pickMailbox(mbs, { email: want });
    if (mailbox) return { mailbox, candidates: rows.length };
  }
  return null;
}

// ── gmail-api: which mailbox a call uses ────────────────────────────────────────────────────────

/**
 * The mailbox for a gmail-api call. An explicit id must be one of the caller's mailboxes (403 otherwise). With none: a reply
 * uses the mailbox the thread arrived on (messages.mailbox_google_connection_id) when that is the caller's, else the primary;
 * everything else uses the primary.
 */
export async function resolveApiMailbox(
  db: SupabaseClient, userId: string, orgId: string, o: { connectionId?: string | null; replyThreadId?: string | null },
): Promise<GmailMailbox> {
  const mbs = await listGmailMailboxes(db, userId, orgId);
  if (!mbs.length) throw new MailboxSelectError("Gmail not connected", 400);
  if (o.connectionId) {
    const mb = pickMailbox(mbs, { connectionId: o.connectionId });
    if (!mb) throw new MailboxSelectError("That Gmail account is not connected for this user", 403);
    return mb;
  }
  if (o.replyThreadId) {
    const { data } = await db.from("messages").select("mailbox_google_connection_id").eq("organization_id", orgId)
      .eq("metadata->>thread_id", o.replyThreadId).not("mailbox_google_connection_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    const arrived = (data as { mailbox_google_connection_id: string | null } | null)?.mailbox_google_connection_id;
    const mb = arrived ? pickMailbox(mbs, { connectionId: arrived }) : null;
    if (mb) return mb;
  }
  return pickMailbox(mbs) ?? mbs[0];
}

/**
 * Gmail thread/message/attachment ids are mailbox-scoped, and conversations are shared org-wide, so the chosen mailbox often 404s
 * an id another connected mailbox holds. Try the chosen one first (one request on the happy path), then the caller's other
 * accounts, then every other connected org mailbox, until one resolves it. Reads org-internal content the OS already synced.
 */
export async function fetchAcrossMailboxes(
  db: SupabaseClient, first: GmailMailbox, firstToken: string, doFetch: (accessToken: string) => Promise<Response>,
  getToken: (userId: string, sel: ConnectionSelector) => Promise<string> = (u, sel) => getGoogleAccessToken(db, u, sel),
): Promise<Response> {
  const res = await doFetch(firstToken);
  // Only a "not here" result is worth trying elsewhere. 401 (bad token) and 5xx are real failures, not a wrong-mailbox signal.
  if (res.ok || (res.status !== 404 && res.status !== 403)) return res;

  const { data } = await db.from("gmail_oauth_tokens").select("user_id, connection_id, email").eq("organization_id", first.orgId);
  const rows = ((data ?? []) as Array<{ user_id: string; connection_id: string | null; email: string | null }>)
    .filter((t) => !(t.connection_id ? t.connection_id === first.connectionId : t.user_id === first.userId && String(t.email ?? "").toLowerCase() === first.email.toLowerCase()))
    .sort((a, b) => Number(b.user_id === first.userId) - Number(a.user_id === first.userId));
  for (const t of rows) {
    try {
      const r = await doFetch(await getToken(t.user_id, t.connection_id ? { connectionId: t.connection_id } : { email: t.email }));
      if (r.ok) return r;
    } catch {
      // unusable mailbox (revoked / needs re-auth): skip and keep looking
    }
  }
  return res;
}
