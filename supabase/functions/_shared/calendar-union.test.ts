import { assertEquals } from "jsr:@std/assert@1";
import { providerForEventId, unionCalendarEvents } from "./calendar-union.ts";

Deno.test("unions Google and Microsoft mirrors into one sorted, provider-tagged list", () => {
  const g = [
    { id: "g1", google_event_id: "ge1", summary: "Google later", start_time: "2026-10-29T15:00:00Z", end_time: "2026-10-29T16:00:00Z", status: "confirmed", hangout_link: "https://meet" },
    { id: "g2", google_event_id: "ge2", summary: "Cancelled", start_time: "2026-10-29T09:00:00Z", end_time: "2026-10-29T10:00:00Z", status: "cancelled" },
  ];
  const m = [
    { id: "m1", graph_event_id: "AAMk1", title: "Teams first", start_time: "2026-10-29T13:00:00Z", end_time: "2026-10-29T14:00:00Z", status: "confirmed", online_meeting_url: "https://teams" },
  ];
  const u = unionCalendarEvents(g, m);
  assertEquals(u.map((e) => [e.provider, e.event_id, e.summary, e.hangout_link]), [
    ["microsoft", "AAMk1", "Teams first", "https://teams"],
    ["google", "ge1", "Google later", "https://meet"],
  ]);
  assertEquals(unionCalendarEvents(g, m, 1).length, 1);
});

Deno.test("routes an event id to the mirror that holds it", () => {
  assertEquals(providerForEventId("AAMk1", ["ge1"], ["AAMk1"]), "microsoft");
  assertEquals(providerForEventId("ge1", ["ge1"], ["AAMk1"]), "google");
  assertEquals(providerForEventId("x", [], []), null);
});
