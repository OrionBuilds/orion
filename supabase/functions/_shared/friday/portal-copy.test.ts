import { assertEquals, assert } from "jsr:@std/assert@1";
import { classifyUnit, composeEntry, featureAreaOf, fallbackEntry, sectionIssues, sectionsToText, type Ask, type WorkUnit } from "./portal-copy.ts";

const unit = (over: Partial<WorkUnit> = {}): WorkUnit => ({
  kind: "pr", ref: "pr#1", title: "Add quote request form", body: "", commits: [{ sha: "a1", subject: "Add quote request form", body: "" }],
  files: [{ path: "src/components/QuoteForm.tsx", additions: 40, deletions: 2 }], occurredAt: "2026-10-02T10:00:00Z", ...over,
});
const GOOD = {
  title: "A simpler way to request a quote",
  context: "You asked for an easier way for visitors to get in touch about pricing.",
  changes: "We added a short quote request form to the site. Visitors now fill in their name, phone and a few details, and it reaches your team straight away.",
  impact: "Visitors will see the new form on the Quote Form area of the site. Everything else works the way it did before.",
  live_now: "This change is live on your site now.",
  check: ["Open the Quote Form and send a test request to yourself."],
};

Deno.test("housekeeping-only changes are noise; a feature that also bumps the lockfile is not", () => {
  assertEquals(classifyUnit(unit({ files: [{ path: "package-lock.json", additions: 9, deletions: 9 }] })).noise, true);
  assertEquals(classifyUnit(unit({ files: [{ path: "package-lock.json", additions: 1, deletions: 1 }, { path: "src/components/QuoteForm.tsx", additions: 1, deletions: 0 }] })).noise, false);
  assertEquals(classifyUnit(unit({ files: [], title: "chore: bump deps", commits: [{ sha: "x", subject: "chore: bump deps", body: "" }] })).noise, true);
  assertEquals(featureAreaOf("src/components/QuoteForm.tsx"), "Quote Form");
});

Deno.test("a clean model reply is used; jargon triggers one repair, then the deterministic fallback", async () => {
  const ok: Ask = () => Promise.resolve(GOOD);
  const e1 = await composeEntry(unit(), { projectName: "Acme", mode: "live" }, ok);
  assertEquals([e1.via, e1.is_live, e1.kind], ["llm", true, "feature"]);

  let calls = 0;
  const dirty = { ...GOOD, changes: GOOD.changes + " We refactored the React component in src/QuoteForm.tsx (PR #12)." };
  const repairs: Ask = () => Promise.resolve(++calls === 1 ? dirty : GOOD);
  assertEquals((await composeEntry(unit(), { projectName: "Acme", mode: "live" }, repairs)).via, "llm-repaired");

  const stubborn: Ask = () => Promise.resolve(dirty);
  const e3 = await composeEntry(unit(), { projectName: "Acme", mode: "live" }, stubborn);
  assertEquals(e3.via, "fallback");
  assert((e3.issues ?? []).length > 0);
  assertEquals(sectionIssues(e3, "live"), []); // the fallback itself is client-clean
});

Deno.test("no model (or an outage) yields an honest fallback, never a throw", async () => {
  const down: Ask = () => Promise.reject(new Error("boom"));
  for (const ask of [null, down]) {
    const e = await composeEntry(unit(), { projectName: "Acme", mode: "live" }, ask);
    assertEquals(e.via, "fallback");
    assert(e.detail.includes("What's live now"));
  }
});

Deno.test("pending mode says ready and waiting, never live", () => {
  const f = fallbackEntry(unit(), { projectName: "Acme", mode: "pending" }, "feature");
  assertEquals(sectionIssues(f, "pending"), []);
  assert(/not live|waiting/i.test(f.sections.live_now) || /waiting/.test(f.sections.live_now));
  assert(sectionsToText(f.sections).length < 4000);
});
