import { assertEquals } from "jsr:@std/assert@1";
import { hmacSha256Hex, verifySiteSignature } from "./site-webhook-auth.ts";

const SECRET = "0123456789abcdef";
const BODY = '{"id":"abc","kind":"contact"}';

async function sign(ts: string, body = BODY, secret = SECRET) {
  return "sha256=" + await hmacSha256Hex(secret, `${ts}.${body}`);
}

Deno.test("accepts a fresh, correctly signed body", async () => {
  const ts = String(Date.now());
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: await sign(ts), secret: SECRET }), "ok");
});

Deno.test("hex case in the signature does not matter", async () => {
  const ts = String(Date.now());
  const sig = (await sign(ts)).toUpperCase().replace("SHA256=", "sha256=");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: sig, secret: SECRET }), "ok");
});

Deno.test("rejects a tampered body, a wrong secret and a malformed header", async () => {
  const ts = String(Date.now());
  const sig = await sign(ts);
  assertEquals(await verifySiteSignature({ rawBody: BODY + " ", timestamp: ts, signature: sig, secret: SECRET }), "mismatch");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: sig, secret: "other" }), "mismatch");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: "deadbeef", secret: SECRET }), "mismatch");
});

Deno.test("rejects timestamps outside the window, in both directions", async () => {
  const now = 1_800_000_000_000;
  const old = String(now - 6 * 60 * 1000);
  const future = String(now + 6 * 60 * 1000);
  const edge = String(now - 4 * 60 * 1000);
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: old, signature: await sign(old), secret: SECRET, nowMs: now }), "stale");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: future, signature: await sign(future), secret: SECRET, nowMs: now }), "stale");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: edge, signature: await sign(edge), secret: SECRET, nowMs: now }), "ok");
});

Deno.test("fails closed without a secret, timestamp or signature", async () => {
  const ts = String(Date.now());
  const sig = await sign(ts);
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: sig, secret: "" }), "missing");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: null, signature: sig, secret: SECRET }), "missing");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: "nan", signature: sig, secret: SECRET }), "missing");
  assertEquals(await verifySiteSignature({ rawBody: BODY, timestamp: ts, signature: null, secret: SECRET }), "missing");
});
