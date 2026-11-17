/**
 * Delegated-mode helpers for teams-meeting-processor, kept out of the function entry point so they are testable.
 * A user may have several Microsoft accounts; a session is tied to the account (connection) whose calendar it came
 * from, because only that account's token can read the transcript and only the organiser's account may.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getValidAccessToken } from "./ms-graph.ts";

export const DETECT_WINDOW_MS = 48 * 3_600_000;
export const CHECK_DELAY_MS = 15 * 60_000;

/**
 * Every active connection's online meetings that ended in the window -> a `detected` session row carrying
 * `connection_id`. Each connection only sees events mirrored from its own calendar, and an event is only filed when
 * the connection's own address is the organiser (only the organiser can read the transcript via delegated Graph).
 */
export async function discoverDelegated(db: SupabaseClient, now: number): Promise<number> {
  const { data: conns } = await db.from("microsoft_oauth_master")
    .select("id, user_id, organization_id, email, is_primary, account_type").eq("connection_status", "active");
  let found = 0;
  const since = new Date(now - DETECT_WINDOW_MS).toISOString();
  for (const conn of (conns ?? []) as { id: string; user_id: string; organization_id: string; email: string; is_primary?: boolean; account_type?: string | null }[]) {
    if ((conn.account_type ?? "work") !== "work") continue; // Teams transcripts are home-organization only
    const { data: events } = await db.from("microsoft_calendar_events")
      .select("graph_event_id, ical_uid, title, start_time, end_time, organizer_email, attendees, online_meeting_url, connection_id")
      .eq("user_id", conn.user_id).eq("is_online_meeting", true)
      .gte("end_time", since).lt("end_time", new Date(now).toISOString());
    for (const e of (events ?? []) as Record<string, string | null>[]) {
      // Rows from before multi-account (no connection yet) belong to the primary account.
      if ((e.connection_id ?? (conn.is_primary ? conn.id : null)) !== conn.id) continue;
      if (!e.online_meeting_url) continue;
      if (e.organizer_email && conn.email && e.organizer_email.toLowerCase() !== conn.email.toLowerCase()) continue;
      await db.from("meeting_sessions").upsert({
        org_id: conn.organization_id, user_id: conn.user_id, connection_id: conn.id, provider: "teams", source: "delegated",
        external_event_id: e.graph_event_id, ical_uid: e.ical_uid ?? null, join_url: e.online_meeting_url,
        title: e.title ?? "Meeting", start_at: e.start_time, end_at: e.end_time,
        organizer_email: e.organizer_email ?? null, attendees: e.attendees ?? [],
        first_check_after: new Date(Date.parse(e.end_time as string) + CHECK_DELAY_MS).toISOString(),
      }, { onConflict: "org_id,provider,external_event_id", ignoreDuplicates: true });
      found++;
    }
  }
  return found;
}

/** The access token for a session: the session's own account, else (older sessions, deleted account) the user's primary. */
export async function sessionToken(
  db: SupabaseClient, sess: { user_id?: unknown; connection_id?: unknown },
  getToken: typeof getValidAccessToken = getValidAccessToken,
): Promise<string> {
  if (sess.connection_id) {
    const { data } = await db.from("microsoft_oauth_master").select("account_type").eq("id", sess.connection_id as string).maybeSingle();
    if (data && ((data as { account_type?: string | null }).account_type ?? "work") !== "work") {
      throw new Error("Teams transcripts are not available for this Microsoft account type");
    }
  }
  return getToken(db, sess.user_id as string, { connectionId: (sess.connection_id as string | null) || undefined });
}
