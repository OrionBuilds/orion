import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildSearchQuery, formatSamDate, noticeLookupRange, SamRequestError, toSamDateFormat } from "./sam-opportunities.ts";

const NOW = new Date("2026-11-12T03:30:00Z"); // still Nov 11 in Eastern

Deno.test("dates are Eastern, not UTC", () => {
  assertEquals(formatSamDate(NOW), "11/11/2026");
  assertEquals(toSamDateFormat("2026-04-21"), "04/21/2026");
  assertEquals(toSamDateFormat("2026-04-21T10:00:00Z"), "04/21/2026");
  assertEquals(toSamDateFormat("04/21/2026"), "04/21/2026");
  assertEquals(toSamDateFormat("soon"), null);
});

Deno.test("search query: mandatory dates default to the last 30 days, limit is clamped, one ptype", () => {
  const q = buildSearchQuery("K", { procurementType: "o", limit: 5000, offset: -3 }, NOW);
  assertEquals(q.get("postedTo"), "11/11/2026");
  assertEquals(q.get("postedFrom"), "10/12/2026");
  assertEquals(q.get("limit"), "1000");
  assertEquals(q.get("offset"), "0");
  assertEquals(q.get("ptype"), "o");
});

Deno.test("search query: a range over one year or backwards is refused with a readable message", () => {
  assertThrows(() => buildSearchQuery("K", { postedFrom: "2025-01-01", postedTo: "2026-11-01" }, NOW), SamRequestError, "1 year");
  assertThrows(() => buildSearchQuery("K", { postedFrom: "2026-11-05", postedTo: "2026-11-01" }, NOW), SamRequestError, "after");
  assertEquals(buildSearchQuery("K", { postedFrom: "2025-11-12", postedTo: "2026-11-11" }, NOW).get("postedFrom"), "11/12/2025");
});

Deno.test("notice lookup always has a valid window", () => {
  const noPosted = noticeLookupRange(null, NOW);
  assertEquals(noPosted.postedTo, "11/11/2026");
  assertEquals(noPosted.postedFrom, "11/12/2025");
  const old = noticeLookupRange("2025-12-01T00:00:00Z", NOW);
  assertEquals(old, { postedFrom: "11/28/2025", postedTo: "09/26/2026" });
});
