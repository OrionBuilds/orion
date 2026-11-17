import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { allowSource, cleanVtt, linkMeeting, processStatusFor, safeName, sha256Hex } from "./ingest.ts";

const NOW = new Date("2026-11-06T12:00:00Z");

Deno.test("cleanVtt: drops header, cue ids, timestamps and markup; keeps Speaker: text", () => {
  const vtt = `WEBVTT

NOTE this is a note

1
00:00:01.000 --> 00:00:04.000
<v Pat Lee>We use ChatGPT for drafting emails.</v>

2
00:00:04.500 --> 00:00:06.000
<v Pat Lee>Mostly the sales team.</v>

3b2f-uuid
00:00:07.000 --> 00:00:09.000
Sam: And the vendor is Acme.
`;
  assertEquals(cleanVtt(vtt), "Pat Lee: We use ChatGPT for drafting emails. Mostly the sales team.\nSam: And the vendor is Acme.");
});

Deno.test("cleanVtt: plain text is returned unchanged", () => {
  assertEquals(cleanVtt("Just notes\n\nsecond paragraph"), "Just notes\n\nsecond paragraph");
});

Deno.test("safeName and sha256Hex", async () => {
  assertEquals(safeName("../../etc/Interview #1 (final).docx"), "Interview_1_final_.docx");
  assertEquals(await sha256Hex("Hello   World"), await sha256Hex(" hello world "));
});

Deno.test("consent: a meeting-derived source is never ready without attestation", () => {
  const none = { pii: [], consent: true, fromMeeting: true, attested: false };
  assertEquals(processStatusFor(none), "needs_review");
  assertEquals(processStatusFor({ ...none, attested: true }), "ready");
  assertEquals(processStatusFor({ pii: [], consent: false, fromMeeting: false, attested: false }), "needs_review");
  assertEquals(processStatusFor({ pii: [{ type: "ssn", count: 1 }], consent: true, fromMeeting: false, attested: false }), "needs_review");
  assertEquals(processStatusFor({ pii: [], consent: true, fromMeeting: false, attested: false }), "ready");
});

function setup() {
  return new FakeSupabase({
    caio_engagements: [{ id: "e1", org_id: "o" }],
    meeting_transcriptions: [{ id: "m1", org_id: "o", meeting_title: "Ops interview", transcript_text: "Pat: we use a spreadsheet." }, { id: "mx", org_id: "other", meeting_title: "x", transcript_text: "y" }],
    caio_sources: [], caio_meeting_links: [],
  }, { unique: { caio_sources: [["engagement_id", "text_hash"]] } });
}
const args = { orgId: "o", userId: "u1", engagementId: "e1", meetingId: "m1", consent: true, now: NOW };

Deno.test("link-meeting without consent links nothing; with consent attests and marks ready", async () => {
  const f = setup();
  const no = await linkMeeting(asClient(f), { ...args, consent: false });
  assertEquals(no.ok, false);
  assertEquals(f.rows("caio_sources").length, 0);
  const yes = await linkMeeting(asClient(f), args);
  assertEquals(yes.ok, true);
  const s = f.rows("caio_sources")[0];
  assertEquals([s.process_status, s.consent_attested_by, s.meeting_transcription_id], ["ready", "u1", "m1"]);
  assertEquals(f.rows("caio_meeting_links")[0].state, "linked");
});

Deno.test("link-meeting refuses a meeting from another org", async () => {
  const f = setup();
  const r = await linkMeeting(asClient(f), { ...args, meetingId: "mx" });
  assertEquals(r.ok, false);
});

Deno.test("allow-source attests the caller and releases the source", async () => {
  const f = new FakeSupabase({ caio_sources: [{ id: "s1", org_id: "o", process_status: "needs_review" }, { id: "s2", org_id: "other", process_status: "needs_review" }] });
  assertEquals((await allowSource(asClient(f), { orgId: "o", userId: "u1", sourceId: "s2", now: NOW })).ok, false);
  assertEquals((await allowSource(asClient(f), { orgId: "o", userId: "u1", sourceId: "s1", now: NOW })).ok, true);
  assertEquals([f.rows("caio_sources")[0].process_status, f.rows("caio_sources")[0].consent_attested_by], ["ready", "u1"]);
  assertEquals(f.rows("caio_sources")[1].process_status, "needs_review");
});

Deno.test("processStatusFor: personal data waits unless the engagement allows it; secrets always wait", () => {
  const ssn = [{ type: "ssn" as const, count: 2 }]; const secret = [{ type: "secret" as const, count: 1 }];
  const base = { consent: true, fromMeeting: false, attested: false };
  assertEquals(processStatusFor({ ...base, pii: ssn }), "needs_review");
  assertEquals(processStatusFor({ ...base, pii: ssn, allowPersonalData: true }), "ready");
  assertEquals(processStatusFor({ ...base, pii: [...ssn, ...secret], allowPersonalData: true }), "needs_review");
  assertEquals(processStatusFor({ ...base, pii: ssn, allowPersonalData: true, consent: false }), "needs_review");
});
