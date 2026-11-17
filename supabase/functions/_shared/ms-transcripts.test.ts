import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  classifyGraphError,
  deltaStartUrl,
  fetchTranscriptText,
  GraphCallError,
  mergeAttendees,
  pickTranscriptForWindow,
  syncTranscripts,
} from "./ms-transcripts.ts";

const err = (code: string | null, message = "x", inner?: string) =>
  JSON.stringify({ error: { code, message, ...(inner ? { innerError: { code: inner } } : {}) } });

Deno.test("classifyGraphError branches on innerError.code, not the message", () => {
  assertEquals(classifyGraphError(403, err("Forbidden", "anything", "GraphAccessToTranscriptsDisabled")), "transcripts_disabled");
  assertEquals(classifyGraphError(403, err("Forbidden", "anything", "SpeakerAttributionNotAllowed")), "speaker_attribution_blocked");
  assertEquals(classifyGraphError(403, err("Forbidden", "No application access policy found for this app")), "no_access_policy");
  assertEquals(classifyGraphError(403, err("Authorization_RequestDenied", "Insufficient privileges")), "forbidden");
  assertEquals(classifyGraphError(401, "not json"), "forbidden");
  assertEquals(classifyGraphError(404, err("NotFound")), "not_found");
  assertEquals(classifyGraphError(429, ""), "throttled");
  assertEquals(classifyGraphError(500, err("InternalServerError")), "other");
});

Deno.test("deltaStartUrl filters by organizer and start time", () => {
  assertEquals(
    deltaStartUrl("u-1", new Date("2026-10-28T00:00:00Z")),
    "/users/u-1/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='u-1',startDateTime=2026-10-28T00:00:00.000Z)/delta",
  );
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.test("syncTranscripts follows nextLink until the deltaLink and returns it to resume from", async () => {
  const pages = [
    { value: [{ id: "t1", meetingId: "m1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?skipToken=a" },
    { value: [{ id: "t2", meetingId: "m2" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/next?deltaToken=b" },
  ];
  const seen: string[] = [];
  const f = ((url: string) => { seen.push(url); return Promise.resolve(json(pages[seen.length - 1])); }) as unknown as typeof fetch;
  const res = await syncTranscripts("tok", "/users/u/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='u')/delta", f);
  assertEquals(res.transcripts.map((t) => t.id), ["t1", "t2"]);
  assertEquals(res.complete, true);
  assertEquals(res.resumeUrl, "https://graph.microsoft.com/v1.0/next?deltaToken=b");
  assertEquals(seen[0].startsWith("https://graph.microsoft.com/v1.0/users/u/"), true);
});

Deno.test("syncTranscripts stops at the page budget and resumes from the last nextLink", async () => {
  const f = (() => Promise.resolve(json({ value: [{ id: "t", meetingId: "m" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/more" }))) as unknown as typeof fetch;
  const res = await syncTranscripts("tok", "/start", f, 2);
  assertEquals(res.transcripts.length, 2);
  assertEquals(res.complete, false);
  assertEquals(res.resumeUrl, "https://graph.microsoft.com/v1.0/more");
});

Deno.test("syncTranscripts surfaces a tenant-level block as a typed error", async () => {
  const f = (() => Promise.resolve(new Response(err("Forbidden", "m", "GraphAccessToTranscriptsDisabled"), { status: 403 }))) as unknown as typeof fetch;
  const e = await assertRejects(() => syncTranscripts("tok", "/start", f), GraphCallError);
  assertEquals((e as GraphCallError).kind, "transcripts_disabled");
});

Deno.test("fetchTranscriptText uses VTT speakers, and falls back to the unattributed format when blocked", async () => {
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana Diaz>Send the proposal Friday.</v>\n";
  const ok = (() => Promise.resolve(new Response(vtt))) as unknown as typeof fetch;
  assertEquals(await fetchTranscriptText("tok", "u", "m", "t", ok), { text: "Ana Diaz: Send the proposal Friday.", attributed: true });

  const calls: { url: string; accept: string | null }[] = [];
  const blocked = ((url: string, init?: RequestInit) => {
    calls.push({ url, accept: new Headers(init?.headers).get("Accept") });
    return Promise.resolve(calls.length === 1
      ? new Response(err("Forbidden", "m", "SpeakerAttributionNotAllowed"), { status: 403 })
      : new Response("  Send the proposal Friday.  "));
  }) as unknown as typeof fetch;
  assertEquals(await fetchTranscriptText("tok", "u", "m", "t", blocked), { text: "Send the proposal Friday.", attributed: false });
  assertEquals(calls[0].url.endsWith("/content?$format=text/vtt"), true);
  assertEquals(calls[1].accept, "application/vnd.microsoft.graph.transcript+text");
});

Deno.test("mergeAttendees keeps who joined first, dedupes by email, keeps names", () => {
  const merged = mergeAttendees(
    [{ email: "Ana@Client.com", name: "Ana Diaz" }, { name: "Dial-in caller" }],
    [{ email: "ana@client.com" }, { email: "bo@client.com", name: "Bo" }, { name: "Ana Diaz" }],
  );
  assertEquals(merged, [
    { email: "ana@client.com", name: "Ana Diaz" },
    { email: "bo@client.com", name: "Bo" },
    { name: "Dial-in caller" },
  ]);
  assertEquals(mergeAttendees(null, [{ email: "x@y.com" }]), [{ email: "x@y.com", name: undefined }]);
});

Deno.test("pickTranscriptForWindow takes this occurrence's transcript from a recurring series", () => {
  const ts = [
    { id: "last-week", createdDateTime: "2026-10-21T15:05:00Z" },
    { id: "this-week", createdDateTime: "2026-10-28T15:04:00Z" },
    { id: "this-week-restart", createdDateTime: "2026-10-28T15:30:00Z" },
  ];
  assertEquals(pickTranscriptForWindow(ts, "2026-10-28T15:00:00Z", "2026-10-28T16:00:00Z")?.id, "this-week-restart");
  assertEquals(pickTranscriptForWindow(ts, "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z"), null);
  assertEquals(pickTranscriptForWindow([{ id: "only", createdDateTime: null }], "bad", "bad")?.id, "only");
});
