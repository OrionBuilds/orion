import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createDraft, listThread, setFlag, trashMessage } from "./ms-mail-ops.ts";

const res = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

Deno.test("createDraft posts recipients to /me/messages and returns the id", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const f = ((url: string, init: RequestInit) => { seen = { url, init }; return Promise.resolve(res({ id: "d1" })); }) as unknown as typeof fetch;
  const out = await createDraft("t", { to: ["a@x.com"], cc: ["c@x.com"], subject: "Hi", body: "Body" }, f);
  assertEquals(out.id, "d1");
  assertStringIncludes(seen!.url, "/me/messages");
  assertEquals(seen!.init.method, "POST");
  const payload = JSON.parse(seen!.init.body as string);
  assertEquals(payload.toRecipients[0].emailAddress.address, "a@x.com");
  assertEquals(payload.ccRecipients[0].emailAddress.address, "c@x.com");
});

Deno.test("trashMessage moves to Deleted Items", async () => {
  let dest = "";
  const f = ((_u: string, init: RequestInit) => { dest = JSON.parse(init.body as string).destinationId; return Promise.resolve(res({}, 201)); }) as unknown as typeof fetch;
  await trashMessage("t", "m1", f);
  assertEquals(dest, "deleteditems");
});

Deno.test("setFlag patches the flag status", async () => {
  let payload: Record<string, unknown> = {};
  const f = ((_u: string, init: RequestInit) => { payload = JSON.parse(init.body as string); return Promise.resolve(res({}, 200)); }) as unknown as typeof fetch;
  await setFlag("t", "m1", true, f);
  assertEquals((payload.flag as { flagStatus: string }).flagStatus, "flagged");
});

Deno.test("listThread filters by conversation and maps to parsed messages", async () => {
  let url = "";
  const f = ((u: string) => { url = u; return Promise.resolve(res({ value: [
    { id: "1", conversationId: "C", subject: "A", from: { emailAddress: { address: "x@y.com", name: "X" } }, sentDateTime: "2026-10-21T00:00:00Z" },
    { id: "2", conversationId: "C", subject: "A", from: { emailAddress: { address: "z@y.com" } }, sentDateTime: "2026-10-21T00:05:00Z" },
  ] })); }) as unknown as typeof fetch;
  const out = await listThread("t", "C", f);
  assertStringIncludes(url, "conversationId eq 'C'");
  assertEquals(out.messages.length, 2);
  assertEquals(out.messages[0].externalId, "ms:1");
  assertEquals(out.messages[0].fromName, "X");
});
