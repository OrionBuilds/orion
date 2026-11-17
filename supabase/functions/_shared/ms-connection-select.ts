/**
 * Small helpers shared by the calendar / contacts / files / Teams functions that act on one of a user's
 * several Microsoft accounts ("connections"; see ms-graph.ts).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { resolveMsConnection } from "./ms-graph.ts";

/**
 * A caller-named connection must belong to the caller. Returns the id to use (undefined = no selector, so the
 * primary is the default) or null when the named account is not the caller's (the function should answer 403).
 */
export async function ownedConnectionId(
  supabase: SupabaseClient, userId: string, requested: unknown,
): Promise<{ connectionId: string | undefined } | null> {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return { connectionId: undefined };
  const conn = await resolveMsConnection(supabase, userId, { connectionId: raw });
  return conn ? { connectionId: conn.id } : null;
}

/**
 * Which of the caller's accounts holds a mirrored event, when the caller did not say. Only an unambiguous match
 * (exactly one connection) is returned; otherwise undefined and the primary stays the default.
 */
export async function connectionOfMirroredEvent(
  supabase: SupabaseClient, userId: string, graphEventId: string,
): Promise<string | undefined> {
  if (!graphEventId) return undefined;
  const { data } = await supabase.from("microsoft_calendar_events").select("connection_id")
    .eq("user_id", userId).eq("graph_event_id", graphEventId);
  const ids = [...new Set(((data ?? []) as { connection_id: string | null }[]).map((r) => r.connection_id).filter(Boolean))] as string[];
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Fair rotation for crons that cap how many connections they walk per run and keep no per-connection
 * "last synced" marker: order by id (stable), then take `cap` items starting at `tick * cap` (wrapping).
 * With N connections every one is visited once every ceil(N / cap) ticks, so none is starved.
 * `tick` is the run's time bucket (e.g. Math.floor(Date.now() / cronPeriodMs)).
 */
export function rotateSlice<T extends { id: string }>(items: T[], cap: number, tick: number): T[] {
  const sorted = [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (sorted.length <= cap) return sorted;
  const start = (Math.floor(tick) * cap) % sorted.length;
  return Array.from({ length: cap }, (_, i) => sorted[(start + i) % sorted.length]);
}
