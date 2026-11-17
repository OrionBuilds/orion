import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { matchEngagement, normalizeEmail, participantEmails, watchMeetings } from "./meeting-match.ts";

const NOW = new Date("2026-11-06T12:00:00Z");

Deno.test("normalizeEmail: case, whitespace, plus-address, display-name forms", () => {
  assertEquals(normalizeEmail("  Pat.Lee+interview@Acme.COM "), "pat.lee@acme.com");
  assertEquals(normalizeEmail("Pat Lee <PAT+x@acme.com>"), "pat@acme.com");
  assertEquals(normalizeEmail("mailto:pat@acme.com"), "pat@acme.com");
  assertEquals(normalizeEmail("not an email"), "");
  assertEquals(normalizeEmail(null), "");
});

Deno.test("matchEngagement: one hit matches; none or several is no match", () => {
  const a = participantEmails([{ name: "Pat", email: "PAT+meet@acme.com" }, { email: "jordan@me.com" }]);
  const engs = [{ id: "e1", client: "Acme", emails: new Set(["pat@acme.com"]) }, { id: "e2", client: "Zed", emails: new Set(["z@zed.com"]) }];
  assertEquals(matchEngagement(a, engs).engagementId, "e1");
  assertEquals(matchEngagement(new Set(["x@y.com"]), engs).engagementId, null);
  assertEquals(matchEngagement(a, [...engs, { id: "e3", client: "Acme 2", emails: new Set(["pat@acme.com"]) }]).ambiguous, true);
});

function seed(extra: Record<string, unknown[]> = {}) {
  return new FakeSupabase({
    caio_engagements: [{ id: "e1", org_id: "o", client_legal_name: "Acme Roofing", contact_id: "c1", status: "active" }],
    contacts: [{ id: "c1", email: "Pat@Acme.com" }],
    meeting_transcriptions: [
      { id: "m1", org_id: "o", meeting_title: "Ops interview", meeting_date: "2026-11-04T10:00:00Z", participants: [{ name: "Pat", email: "pat+ops@acme.com" }], transcript_text: "Pat: we use a spreadsheet.", contact_id: null },
      { id: "m2", org_id: "o", meeting_title: "Lunch", meeting_date: "2026-11-05T10:00:00Z", participants: [{ email: "friend@else.com" }], transcript_text: "hello there", contact_id: null },
      { id: "m3", org_id: "o", meeting_title: "Ancient", meeting_date: "2026-01-01T10:00:00Z", participants: [{ email: "pat@acme.com" }], transcript_text: "old", contact_id: null },
      { id: "m4", org_id: "o", meeting_title: "No transcript", meeting_date: "2026-11-05T11:00:00Z", participants: [{ email: "pat@acme.com" }], transcript_text: "  ", contact_id: null },
    ],
    meeting_transcription_contacts: [], caio_meeting_links: [], caio_sources: [], ...extra,
  }, { unique: { caio_meeting_links: [["meeting_transcription_id"]] } });
}

Deno.test("watch: a matched meeting becomes a needs_review source (consent not attested) and one notice", async () => {
  const f = seed(); const notes: { text: string; dedupeKey: string }[] = [];
  const res = await watchMeetings(asClient(f), { now: NOW, notify: (_o, n) => { notes.push(n); return Promise.resolve(); } });
  assertEquals([res.linked, res.needsLink], [1, 1]);
  const s = f.rows("caio_sources")[0];
  assertEquals([s.meeting_transcription_id, s.process_status, s.consent_attested_at ?? null], ["m1", "needs_review", null]);
  const link = f.rows("caio_meeting_links").find((l) => l.meeting_transcription_id === "m1")!;
  assertEquals([link.state, link.match_method, link.engagement_id], ["linked", "email", "e1"]);
  const linked = notes.find((n) => n.dedupeKey === "caio-meeting:m1")!;
  assertEquals(linked.text, '"Ops interview" looks like a Acme Roofing interview: confirm you may process it (CAIO > Sources).');
});

Deno.test("watch: the no-match path creates needs_link and only ONE daily summary notice (never one per meeting), even across runs", async () => {
  const f = seed(); const notes: { dedupeKey: string }[] = [];
  const notify = (_o: string, n: { dedupeKey: string }) => { notes.push(n); return Promise.resolve(); };
  await watchMeetings(asClient(f), { now: NOW, notify });
  await watchMeetings(asClient(f), { now: NOW, notify });
  const m2 = f.rows("caio_meeting_links").filter((l) => l.meeting_transcription_id === "m2");
  assertEquals([m2.length, m2[0].state], [1, "needs_link"]);
  assertEquals(notes.filter((n) => n.dedupeKey === "caio-meeting:m2").length, 0);
  assertEquals(notes.filter((n) => n.dedupeKey.startsWith("caio-meetings-unmatched:")).length, 1);
  assertEquals(f.rows("caio_meeting_links").length, 2); // old and empty-transcript meetings are never touched
  assertEquals(f.rows("meeting_transcriptions").length, 4);
});

Deno.test("watch: a meeting linked to the engagement contact through meeting_transcription_contacts matches", async () => {
  const f = seed();
  f.rows("meeting_transcriptions")[1].participants = [];
  f.rows("meeting_transcription_contacts").push({ meeting_transcription_id: "m2", contact_id: "c1", participant_email: "pat@acme.com" });
  const res = await watchMeetings(asClient(f), { now: NOW, notify: () => Promise.resolve() });
  assertEquals(res.linked, 2);
});

Deno.test("watch: the cap limits meetings per run, newest first", async () => {
  const f = seed();
  const res = await watchMeetings(asClient(f), { now: NOW, cap: 1, notify: () => Promise.resolve() });
  assertEquals(res.linked + res.needsLink, 1);
  assertEquals(f.rows("caio_meeting_links")[0].meeting_transcription_id, "m2");
});
