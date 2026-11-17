import { assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { replyClearsUnread } from "./unread.ts";

/** Minimal query fake: team_channels answers by agent_user_id, messages returns the newest inbound sent_at. */
function fakeDb(agents: string[], lastInbound: string | null): SupabaseClient {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters[col] = val; return q; },
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve({
          data: table === "team_channels"
            ? (agents.includes(filters.agent_user_id as string) ? { id: "ch" } : null)
            : (lastInbound ? { sent_at: lastInbound } : null),
          error: null,
        }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

Deno.test("the owner's reply sent after the customer's last mail clears unread", async () => {
  assertEquals(await replyClearsUnread(fakeDb([], "2026-10-29T20:59:50Z"), "c", "jordan", "2026-10-30T14:21:09Z"), true);
});

Deno.test("an older sent item imported after a newer customer mail does not clear it", async () => {
  assertEquals(await replyClearsUnread(fakeDb([], "2026-10-30T09:00:00Z"), "c", "jordan", "2026-10-29T08:00:00Z"), false);
});

Deno.test("mail from an agent's mailbox (Clara) does not clear it", async () => {
  assertEquals(await replyClearsUnread(fakeDb(["clara"], "2026-10-29T20:59:50Z"), "c", "clara", "2026-10-30T14:21:09Z"), false);
});

Deno.test("no sender or no inbound mail at all", async () => {
  assertEquals(await replyClearsUnread(fakeDb([], null), "c", null, "2026-10-30T14:21:09Z"), false);
  assertEquals(await replyClearsUnread(fakeDb([], null), "c", "jordan", "2026-10-30T14:21:09Z"), true);
});
