import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  formatScribeTranscript,
  parseDriveFileId,
  rechunk,
  resolveRecordingSource,
  transcribeRecordingUrl,
  tusUpload,
} from "./recording-transcribe.ts";

Deno.test("parseDriveFileId handles Drive URL shapes and rejects non-Google hosts", () => {
  assertEquals(parseDriveFileId("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=drive_link"), "1AbCdEfGhIjKlMn");
  assertEquals(parseDriveFileId("https://drive.google.com/open?id=1AbCdEfGhIjKlMn"), "1AbCdEfGhIjKlMn");
  assertEquals(parseDriveFileId("https://evil.example/file/d/1AbCdEfGhIjKlMn/view"), null);
  assertEquals(parseDriveFileId(null), null);
});

Deno.test("resolveRecordingSource per provider", () => {
  assertEquals(resolveRecordingSource({ meeting_source: "google_meet", recording_url: null, recording_file_id: "f1" }), { kind: "google_drive", fileId: "f1" });
  assertEquals(resolveRecordingSource({ meeting_source: "teams", recording_url: "https://x.sharepoint.com/r.mp4", recording_file_id: "item1" }), { kind: "onedrive", itemId: "item1" });
  assertEquals(resolveRecordingSource({ meeting_source: "teams", recording_url: "https://graph.microsoft.com/v1.0/me/onlineMeetings/a/recordings/b/content", recording_file_id: null }).kind, "graph_url");
  assertEquals(resolveRecordingSource({ meeting_source: "zoom", recording_url: "https://zoom.us/rec/1", recording_file_id: null }).kind, "unsupported");
  assertEquals(resolveRecordingSource({ meeting_source: "google_meet", recording_url: null, recording_file_id: null }).kind, "unsupported");
});

function streamOf(parts: number[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= parts.length) return c.close();
      c.enqueue(new Uint8Array(parts[i]).fill(i + 1));
      i++;
    },
  });
}

Deno.test("rechunk emits fixed-size chunks with a short tail", async () => {
  const sizes: number[] = [];
  for await (const c of rechunk(streamOf([3, 5, 1, 7]), 4)) sizes.push(c.byteLength);
  assertEquals(sizes, [4, 4, 4, 4]);
  const tail: number[] = [];
  for await (const c of rechunk(streamOf([5]), 4)) tail.push(c.byteLength);
  assertEquals(tail, [4, 1]);
});

Deno.test("tusUpload creates then PATCHes sequential offsets", async () => {
  const calls: { method: string; headers: Headers; len: number }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    const len = init.body instanceof Uint8Array ? init.body.byteLength : 0;
    calls.push({ method: init.method!, headers: h, len });
    if (init.method === "POST") return Promise.resolve(new Response(null, { status: 201, headers: { location: "/storage/v1/upload/resumable/abc" } }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  const size = 6 * 1024 * 1024 + 10;
  const r = await tusUpload({
    supabaseUrl: "https://p.supabase.co", serviceKey: "k", bucket: "b", path: "o/m.mp4", contentType: "video/mp4",
    size, stream: streamOf([size]), fetchImpl,
  });
  assertEquals(r.error, null);
  assertEquals(calls.map((c) => c.method), ["POST", "PATCH", "PATCH"]);
  assertEquals(calls[0].headers.get("Upload-Length"), String(size));
  assertEquals(calls[1].headers.get("Upload-Offset"), "0");
  assertEquals(calls[2].headers.get("Upload-Offset"), String(6 * 1024 * 1024));
  assertEquals(calls[2].len, 10);
});

Deno.test("formatScribeTranscript groups diarised words by speaker", () => {
  const t = formatScribeTranscript({
    text: "Hi there. Hello.",
    words: [
      { text: "Hi", type: "word", speaker_id: "speaker_0" }, { text: " ", type: "spacing", speaker_id: "speaker_0" },
      { text: "there.", type: "word", speaker_id: "speaker_0" }, { text: " ", type: "spacing", speaker_id: "speaker_1" },
      { text: "(laughs)", type: "audio_event", speaker_id: "speaker_1" },
      { text: "Hello.", type: "word", speaker_id: "speaker_1" },
    ],
  });
  assertEquals(t, "Speaker 1: Hi there.\nSpeaker 2: Hello.");
  assertEquals(formatScribeTranscript({ text: " plain " }), "plain");
});

Deno.test("transcribeRecordingUrl sends cloud_storage_url, falls back to upload for small files", async () => {
  const forms: FormData[] = [];
  let n = 0;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    if (url.startsWith("https://api.elevenlabs.io")) {
      forms.push(init!.body as FormData);
      n++;
      return Promise.resolve(n === 1
        ? new Response(JSON.stringify({ detail: { message: "cloud_storage_url not accessible" } }), { status: 422 })
        : new Response(JSON.stringify({ text: "transcribed", language_code: "en" }), { status: 200 }));
    }
    return Promise.resolve(new Response(new Uint8Array(5), { status: 200 }));
  }) as unknown as typeof fetch;
  const r = await transcribeRecordingUrl("key", "https://signed.example/rec.mp4", { sizeBytes: 5, fetchImpl });
  assert(r.ok);
  if (r.ok) assertEquals(r.text, "transcribed");
  assertEquals(forms[0].get("cloud_storage_url"), "https://signed.example/rec.mp4");
  assert(forms[1].get("file") instanceof Blob);

  n = 0;
  forms.length = 0;
  const big = await transcribeRecordingUrl("key", "https://signed.example/rec.mp4", { sizeBytes: 500 * 1024 * 1024, fetchImpl });
  assert(!big.ok);
  assertEquals(forms.length, 1, "no in-memory fallback for large recordings");
});
