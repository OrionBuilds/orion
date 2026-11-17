import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  buildSamResourceRequestUrl,
  downloadSamResource,
  isAllowedRedirectHost,
  parseContentDispositionFilename,
  sanitizeFilename,
  sanitizeSamSourceUrl,
  samResourceId,
  type StorageLike,
  syncSamDocuments,
} from "./sam-documents.ts";
import { asClient, FakeSupabase } from "./testing/fake-supabase.ts";

const KEY = "SECRET-KEY";
const LINK_A = "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/abc123/download?api_key=null&token=";
const LINK_B = "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/def456/download";

function resp(status: number, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

Deno.test("SAM URL helpers: trusted hosts only, key never stored", () => {
  assertEquals(samResourceId(LINK_A), "abc123");
  assertEquals(samResourceId("https://sam.gov/opp/x/view"), null);
  const clean = sanitizeSamSourceUrl(LINK_A)!;
  assertFalse(clean.includes("api_key"));
  assertFalse(clean.includes("token"));
  assertEquals(sanitizeSamSourceUrl("http://sam.gov/x"), null);
  assertEquals(sanitizeSamSourceUrl("https://evil.example/x"), null);
  assertEquals(sanitizeSamSourceUrl("https://sam.gov.evil.example/x"), null);
  assertEquals(buildSamResourceRequestUrl(LINK_A, KEY)!.searchParams.get("api_key"), KEY);
  assertEquals(buildSamResourceRequestUrl("https://169.254.169.254/latest", KEY), null);
  assert(isAllowedRedirectHost("falextracts.s3.amazonaws.com"));
  assertFalse(isAllowedRedirectHost("amazonaws.com.evil.example"));
  assertFalse(isAllowedRedirectHost("localhost"));
});

Deno.test("Content-Disposition filename parsing + sanitising", () => {
  assertEquals(parseContentDispositionFilename('attachment; filename="RFP Section L.pdf"'), "RFP Section L.pdf");
  assertEquals(parseContentDispositionFilename("attachment; filename*=UTF-8''Amendment%20%231.docx"), "Amendment #1.docx");
  assertEquals(parseContentDispositionFilename("attachment; filename=plain.txt"), "plain.txt");
  assertEquals(parseContentDispositionFilename(null), null);
  assertEquals(sanitizeFilename("../../etc/passwd"), "passwd");
  assertEquals(sanitizeFilename("a\u0000b.pdf"), "ab.pdf");
  assertEquals(sanitizeFilename(".."), null);
});

Deno.test("download follows SAM → S3 redirect, strips the key off-host, reads filename", async () => {
  const seen: string[] = [];
  const fetchImpl = ((url: string) => {
    seen.push(url);
    if (url.startsWith("https://sam.gov/")) {
      return Promise.resolve(resp(303, null, {
        location: "https://falextracts.s3.amazonaws.com/att/abc123?X-Amz-Signature=sig&api_key=leak",
      }));
    }
    return Promise.resolve(resp(200, "hello", {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="SOW.txt"',
    }));
  }) as typeof fetch;
  const r = await downloadSamResource(LINK_A, KEY, { fetchImpl });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.filename, "SOW.txt");
    assertEquals(r.mime, "text/plain");
    assertEquals(new TextDecoder().decode(r.bytes), "hello");
  }
  assert(seen[0].includes(`api_key=${KEY}`));
  assertFalse(seen[1].includes("api_key"), "the SAM key must not be sent to S3");
});

Deno.test("download rejects untrusted redirects, bad types and oversize bodies", async () => {
  const toEvil = (() => Promise.resolve(resp(302, null, { location: "https://169.254.169.254/meta" }))) as unknown as typeof fetch;
  const a = await downloadSamResource(LINK_A, KEY, { fetchImpl: toEvil });
  assertEquals(a.ok ? "" : a.reason, "untrusted");

  const image = (() => Promise.resolve(resp(200, "x", { "content-type": "image/png" }))) as unknown as typeof fetch;
  const b = await downloadSamResource(LINK_A, KEY, { fetchImpl: image });
  assertEquals(b.ok ? "" : b.reason, "content_type");

  const big = (() => Promise.resolve(resp(200, "x".repeat(100), { "content-type": "text/plain" }))) as unknown as typeof fetch;
  const c = await downloadSamResource(LINK_A, KEY, { fetchImpl: big, maxBytes: 10 });
  assertEquals(c.ok ? "" : c.reason, "too_large");

  const declared = (() => Promise.resolve(resp(200, "x", { "content-type": "text/plain", "content-length": "999999999" }))) as unknown as typeof fetch;
  const d = await downloadSamResource(LINK_A, KEY, { fetchImpl: declared });
  assertEquals(d.ok ? "" : d.reason, "too_large");

  const e = await downloadSamResource("https://example.com/file.pdf", KEY, { fetchImpl: big });
  assertEquals(e.ok ? "" : e.reason, "untrusted");

  const boom = (() => Promise.reject(new Error(`connect failed https://sam.gov/x?api_key=${KEY}`))) as unknown as typeof fetch;
  const f = await downloadSamResource(LINK_A, KEY, { fetchImpl: boom });
  assert(!f.ok && !f.error.includes(KEY), "errors must not echo the API key");
});

Deno.test("syncSamDocuments stores, records, attaches, extracts and upgrades legacy placeholders", async () => {
  const db = new FakeSupabase({
    drive_files: [{ id: "legacy-1", organization_id: "org1", drive_file_id: "sam-gov-opp1-res-1", name: "SAM.gov Related Document 2", size_bytes: 0, storage_path: null, is_deleted: true }],
  });
  const uploads: string[] = [];
  const storage: StorageLike = { upload: (p) => { uploads.push(p); return Promise.resolve({ error: null }); } };
  const fetchImpl = ((url: string) => {
    const name = url.includes("abc123") ? "Solicitation.txt" : "Amendment 1.txt";
    return Promise.resolve(resp(200, `Text of ${name}`, { "content-type": "text/plain", "content-disposition": `attachment; filename="${name}"` }));
  }) as typeof fetch;

  const base = { orgId: "org1", userId: "u1", opportunityId: "opp1", noticeId: "N1", resourceLinks: [LINK_A, LINK_B], apiKey: KEY, storage, fetchImpl, noticeUiLink: "https://sam.gov/opp/N1/view" };
  const res = await syncSamDocuments(asClient(db), base);
  assertEquals(res.map((r) => r.status), ["stored", "stored"]);
  assertEquals(res.map((r) => r.name), ["Solicitation.txt", "Amendment 1.txt"]);

  const files = db.rows("drive_files");
  assertEquals(files.length, 2, "legacy placeholder is upgraded in place, not duplicated");
  const legacy = files.find((f) => f.id === "legacy-1")!;
  assertEquals(legacy.drive_file_id, "sam-gov:N1:def456");
  assertEquals(legacy.name, "Amendment 1.txt");
  assertEquals(legacy.is_deleted, false);
  assertEquals(legacy.provider, "sam_gov");
  for (const f of files) assertFalse(String(f.source_url).includes(KEY));
  assert(uploads.every((p) => p.startsWith("org1/sam-gov/opp1/")));

  assertEquals(db.rows("document_texts").length, 2);
  assertEquals(db.rows("document_texts")[0].text_content, "Text of Solicitation.txt");
  assertEquals(db.rows("file_attachments").length, 2);

  // Second run is a no-op (unchanged) and does not download again.
  let calls = 0;
  const counting = ((u: string) => { calls++; return fetchImpl(u); }) as typeof fetch;
  const again = await syncSamDocuments(asClient(db), { ...base, fetchImpl: counting });
  assertEquals(again.map((r) => r.status), ["unchanged", "unchanged"]);
  assertEquals(calls, 0);
  assertEquals(db.rows("file_attachments").length, 2);
});

Deno.test("syncSamDocuments respects the time budget and reports failures", async () => {
  const db = new FakeSupabase();
  let t = 0;
  const storage: StorageLike = { upload: () => Promise.resolve({ error: null }) };
  const fetchImpl = (() => { t += 60_000; return Promise.resolve(resp(404, "nope")); }) as unknown as typeof fetch;
  const res = await syncSamDocuments(asClient(db), {
    orgId: "o", userId: "u", opportunityId: "p", noticeId: null, resourceLinks: [LINK_A, LINK_B, "https://evil.example/x"],
    apiKey: KEY, storage, fetchImpl, budgetMs: 30_000, now: () => t,
  });
  assertEquals(res.map((r) => r.status), ["failed", "pending", "pending"]);
  assertEquals(db.rows("drive_files").length, 0);
});
