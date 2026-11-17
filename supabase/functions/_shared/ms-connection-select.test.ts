import { assertEquals } from "jsr:@std/assert@1";
import { connectionOfMirroredEvent, ownedConnectionId, rotateSlice } from "./ms-connection-select.ts";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";

const db = () => new FakeSupabase({
  microsoft_oauth_master: [
    { id: "c1", user_id: "u", email: "a@x.com", is_primary: true },
    { id: "c2", user_id: "u", email: "b@x.com", is_primary: false },
    { id: "cz", user_id: "other", email: "z@x.com", is_primary: true },
  ],
  microsoft_calendar_events: [
    { id: "1", user_id: "u", graph_event_id: "A", connection_id: "c2" },
    { id: "2", user_id: "u", graph_event_id: "S", connection_id: "c1" },
    { id: "3", user_id: "u", graph_event_id: "S", connection_id: "c2" },
  ],
});

Deno.test("ownedConnectionId: no selector = default; own account ok; another user's account refused", async () => {
  assertEquals(await ownedConnectionId(asClient(db()), "u", undefined), { connectionId: undefined });
  assertEquals(await ownedConnectionId(asClient(db()), "u", ""), { connectionId: undefined });
  assertEquals(await ownedConnectionId(asClient(db()), "u", "c2"), { connectionId: "c2" });
  assertEquals(await ownedConnectionId(asClient(db()), "u", "cz"), null);
  assertEquals(await ownedConnectionId(asClient(db()), "u", "nope"), null);
});

Deno.test("connectionOfMirroredEvent: unambiguous match only", async () => {
  assertEquals(await connectionOfMirroredEvent(asClient(db()), "u", "A"), "c2");
  assertEquals(await connectionOfMirroredEvent(asClient(db()), "u", "S"), undefined); // on two accounts: do not guess
  assertEquals(await connectionOfMirroredEvent(asClient(db()), "u", "missing"), undefined);
});

Deno.test("rotateSlice: more than cap connections are all visited within ceil(N/cap) ticks, none starved", () => {
  const all = Array.from({ length: 25 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}` }));
  const seen = new Set<string>();
  for (let tick = 100; tick < 103; tick++) {
    const slice = rotateSlice(all, 10, tick);
    assertEquals(slice.length, 10);
    assertEquals(new Set(slice.map((s) => s.id)).size, 10);
    slice.forEach((s) => seen.add(s.id));
  }
  assertEquals(seen.size, 25);
  // shuffled input gives the same slice; at or under the cap everything runs every time
  assertEquals(rotateSlice([...all].reverse(), 10, 7).map((s) => s.id), rotateSlice(all, 10, 7).map((s) => s.id));
  assertEquals(rotateSlice(all.slice(0, 4), 10, 9).length, 4);
});
