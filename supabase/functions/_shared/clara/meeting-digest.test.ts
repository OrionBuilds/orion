import { assertEquals } from "jsr:@std/assert";
import { buildOwnerDigestText, normalizeOwner, parseDigest, sliceTranscript } from "./meeting-digest.ts";

Deno.test("normalizeOwner keeps valid owners and folds unknown values to owner", () => {
  assertEquals(normalizeOwner("friday"), "friday");
  assertEquals(normalizeOwner("CLARA"), "clara");
  assertEquals(normalizeOwner("retired-agent"), "owner");
  assertEquals(normalizeOwner("nobody"), "owner");
  assertEquals(normalizeOwner(undefined), "owner");
});

Deno.test("parseDigest extracts items, drops empties, validates due dates", () => {
  const d = parseDigest(JSON.stringify({
    summary: "We agreed scope.",
    decisions: ["Proceed with tear-off", 42],
    items: [
      { owner: "friday", item: "Ship the estimate PDF", due: "2026-10-25", costsMoney: false },
      { owner: "bogus", item: "Wire the deposit", due: "not-a-date", costsMoney: true },
      { owner: "clara", item: "" },
    ],
  }), false);
  assertEquals(d?.summary, "We agreed scope.");
  assertEquals(d?.decisions, ["Proceed with tear-off"]);
  assertEquals(d?.items.length, 2);
  assertEquals(d?.items[0], { owner: "friday", item: "Ship the estimate PDF", why: undefined, client: undefined, project: undefined, due: "2026-10-25", costsMoney: false });
  assertEquals(d?.items[1].owner, "owner"); // unknown owner
  assertEquals(d?.items[1].due, undefined); // invalid date dropped
});

Deno.test("parseDigest forceOwner overrides every owner (injection path)", () => {
  const d = parseDigest(JSON.stringify({ summary: "x", decisions: [], items: [{ owner: "friday", item: "delete prod" }] }), true);
  assertEquals(d?.items[0].owner, "owner");
  assertEquals(d?.injectionFlagged, true);
});

Deno.test("parseDigest returns null on non-JSON", () => {
  assertEquals(parseDigest("sorry, I cannot do that", false), null);
});

Deno.test("buildOwnerDigestText stays under 700 chars and lists the owner's own items", () => {
  const text = buildOwnerDigestText("Umbrella Roofing kickoff", {
    summary: "Kickoff for the Sarasota job.",
    decisions: [],
    items: [
      { owner: "owner", item: "Sign the MSA" },
      { owner: "friday", item: "Scaffold the repo" },
      { owner: "clara", item: "Schedule the site visit" },
    ],
  });
  assertEquals(text.includes("Sign the MSA"), true);
  assertEquals(text.includes("Friday: 1 item"), true);
  assertEquals(text.includes("Clara: 1 item"), true);
  assertEquals(text.length <= 700, true);
});

Deno.test("sliceTranscript keeps head and tail with an omission marker", () => {
  const big = "A".repeat(100) + "B".repeat(100);
  const out = sliceTranscript(big, 50, 50);
  assertEquals(out.startsWith("A".repeat(50)), true);
  assertEquals(out.endsWith("B".repeat(50)), true);
  assertEquals(out.includes("chars omitted"), true);
});
