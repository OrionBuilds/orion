import { assertEquals } from "jsr:@std/assert@1";
import { buildFailureDigest, type FailingSource } from "./ai-failure-watch.ts";

const row = (o: Partial<FailingSource>): FailingSource => ({ source: "dashboard-insights", agent: "os", calls: 4, errors: 4, error_rate: "1.00", last_error_at: null, last_error_message: "HTTP 401: invalid x-api-key", ...o });
const NOW = new Date("2026-11-12T13:20:00Z");

Deno.test("nothing failing means no notification", () => {
  assertEquals(buildFailureDigest([], NOW), null);
});

Deno.test("digest names each source with its counts and latest reason, dedupes per Eastern day and source set", () => {
  const d = buildFailureDigest([row({}), row({ source: "clara-briefs", agent: "clara", calls: 2, errors: 2, last_error_message: null })], NOW)!;
  assertEquals(d.title, "2 AI agent functions are failing");
  assertEquals(d.body.split("\n")[0], "dashboard-insights (os): 4 of 4 calls failed — HTTP 401: invalid x-api-key");
  assertEquals(d.body.split("\n")[1], "clara-briefs (clara): 2 of 2 calls failed — reason not recorded yet");
  assertEquals(d.dedupe, "ai-failing:2026-11-12:clara-briefs,dashboard-insights");
  assertEquals(buildFailureDigest([row({})], NOW)!.title, "An AI agent function is failing");
});

Deno.test("a long list is capped", () => {
  const rows = Array.from({ length: 11 }, (_, i) => row({ source: `s${i}` }));
  const d = buildFailureDigest(rows, NOW)!;
  assertEquals(d.body.split("\n").length, 9);
  assertEquals(d.body.endsWith("…and 3 more"), true);
});
