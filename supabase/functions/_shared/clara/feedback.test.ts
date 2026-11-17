import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { FEEDBACK_ASK_MARKER, captureFeedbackReplies, parseFeedbackScore, stripQuoted } from "./feedback.ts";
import type { NotifyRequest } from "./notify.ts";

const NOW = new Date("2026-10-20T15:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

Deno.test("digit wins, words only on short replies, anything else is conversation", () => {
  assertEquals(parseFeedbackScore("5"), { score: 5, via: "digit" });
  assertEquals(parseFeedbackScore("4/5 — thanks!"), { score: 4, via: "digit" });
  assertEquals(parseFeedbackScore("Great work"), { score: 5, via: "word" });
  assertEquals(parseFeedbackScore("not great honestly"), { score: 2, via: "word" });
  assertEquals(parseFeedbackScore("Thanks! Could you also change the footer, the site looks great overall and I wanted to mention the other page we talked about last week too"), null);
  assertEquals(parseFeedbackScore("  "), null);
  assertEquals(parseFeedbackScore("2 products are broken"), { score: 2, via: "digit" }); // deterministic by design
});

Deno.test("quoted history never counts as the reply", () => {
  assertEquals(stripQuoted("Thanks, 4\n\nOn Mon, Oct 19, 2026 at 9:00 AM Clara wrote:\n> how'd we do on this one? 1-5").trim(), "Thanks, 4");
  assertEquals(parseFeedbackScore("\n> 5 stars\nI'd say it was fine"), { score: 3, via: "word" });
});

function setup(extraMsgs: Record<string, unknown>[] = [], asked = ago(3)) {
  const f = new FakeSupabase({
    contacts: [{ id: "c1", first_name: "Pat", last_name: "Lee", company: "Acme" }],
    messages: [
      { id: "ask", organization_id: "o", contact_id: "c1", channel: "email", direction: "outbound", body: `Done! Quick favor — ${FEEDBACK_ASK_MARKER}?`, sent_at: asked },
      ...extraMsgs,
    ],
    contact_timeline: [] as Record<string, unknown>[],
  });
  const notes: NotifyRequest[] = [];
  return { f, notes, run: () => captureFeedbackReplies(asClient(f), { orgId: "o", now: NOW, notify: (r) => { notes.push(r); return Promise.resolve(); } }) };
}

Deno.test("a reply to the ask is recorded once; a low score notifies right away, a high one waits for the brief", async () => {
  const low = setup([{ id: "r1", organization_id: "o", contact_id: "c1", channel: "email", direction: "inbound", body: "2 — the checkout still breaks", sent_at: ago(2) }]);
  assertEquals((await low.run()).recorded, 1);
  assertEquals((low.f.rows("contact_timeline")[0].event_data as { score: number }).score, 2);
  assertEquals([low.notes[0].priority, low.notes[0].category], ["critical", "revenue"]);
  assertEquals((await low.run()).recorded, 0); // already answered
  assertEquals(low.f.rows("contact_timeline").length, 1);

  const high = setup([{ id: "r2", organization_id: "o", contact_id: "c1", channel: "email", direction: "inbound", body: "5!", sent_at: ago(1) }]);
  await high.run();
  assertEquals([high.notes[0].priority, high.notes[0].category], ["normal", undefined]);
});

Deno.test("no ask in the window, or an unrelated reply, records nothing", async () => {
  const stale = setup([{ id: "r1", organization_id: "o", contact_id: "c1", channel: "email", direction: "inbound", body: "5", sent_at: ago(1) }], ago(30));
  assertEquals((await stale.run()).recorded, 0);
  const chatter = setup([{ id: "r1", organization_id: "o", contact_id: "c1", channel: "email", direction: "inbound", body: "Can you send me last month's invoice and also update the homepage banner for the fall sale please", sent_at: ago(1) }]);
  assertEquals((await chatter.run()).recorded, 0);
  const before = setup([{ id: "r1", organization_id: "o", contact_id: "c1", channel: "email", direction: "inbound", body: "5", sent_at: ago(5) }]);
  assertEquals((await before.run()).recorded, 0); // replies BEFORE the ask are not answers to it
});
