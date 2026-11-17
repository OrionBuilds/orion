import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { asClient, FakeSupabase } from "./testing/fake-supabase.ts";
import { dispatchMail, MailSelectorError } from "./mail-dispatch.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
const seed = (extra: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  users: [{ id: "u1", organization_id: "o1", email: "jordan@a.com", name: "Jordan" }, { id: "u2", organization_id: "o1", email: "bob@x.com", name: "Bob" }],
  microsoft_oauth_master: [
    { id: "conn-a", user_id: "u1", email: "jordan@a.com", is_primary: true, created_at: "2026-01-01" },
    { id: "conn-b", user_id: "u1", email: "jordan@b.com", is_primary: false, created_at: "2026-02-01" },
    { id: "conn-x", user_id: "u2", email: "bob@x.com", is_primary: true, created_at: "2026-01-01" },
  ],
  messages: [
    { organization_id: "o1", external_id: "ms:ON_B", subject: "Quote", direction: "inbound", mailbox_connection_id: "conn-b", metadata: { from_email: "pat@client.com", rfc_message_id: "<r@c>" } },
    { organization_id: "o1", external_id: "ms:LEGACY", subject: "Old", direction: "inbound", mailbox_connection_id: null, metadata: { from_email: "pat@client.com" } },
    { organization_id: "o1", external_id: "ms:BOBS", subject: "Bobs", direction: "inbound", mailbox_connection_id: "conn-x", metadata: { from_email: "pat@client.com" } },
  ],
  ...extra,
});

/** Records the Graph calls and which connection each token was asked for. */
function harness() {
  const asked: Array<string | undefined> = [];
  const calls: string[] = [];
  const getToken = (_d: unknown, _u: string, o?: { connectionId?: string }) => { asked.push(o?.connectionId); return Promise.resolve(`tok-${o?.connectionId ?? "primary"}`); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${new Headers(init?.headers).get("Authorization")} ${String(url)}`);
    return Promise.resolve(new Response("", { status: 202 }));
  }) as typeof fetch;
  return { asked, calls, getToken, restore: () => { globalThis.fetch = realFetch; } };
}
const newMail = { to: ["a@x.com"], subject: "s", body: "b" };

Deno.test("a new message goes out from the primary; no connection is named (single-account behaviour)", async () => {
  const h = harness();
  try {
    await dispatchMail(asClient(seed()), { userId: "u1", mail: newMail }, { env: env({}), getToken: h.getToken });
    assertEquals(h.asked, [undefined]);
    assertEquals(h.calls[0].startsWith("Bearer tok-primary"), true);
  } finally { h.restore(); }
});

Deno.test("a reply defaults to the mailbox the message arrived on; a legacy message to the primary", async () => {
  const h = harness();
  try {
    const db = asClient(seed());
    await dispatchMail(db, { userId: "u1", replyToMessageId: "ON_B", mail: { to: [], subject: "", body: "x" } }, { env: env({}), getToken: h.getToken });
    await dispatchMail(db, { userId: "u1", replyToMessageId: "LEGACY", mail: { to: [], subject: "", body: "x" } }, { env: env({}), getToken: h.getToken });
    assertEquals(h.asked, ["conn-b", undefined]);
    assertEquals(h.calls[0].includes("/me/messages/ON_B/reply"), true);
  } finally { h.restore(); }
});

Deno.test("a reply to a message that arrived on someone else's mailbox falls back to the sender's primary", async () => {
  const h = harness();
  try {
    await dispatchMail(asClient(seed()), { userId: "u1", replyToMessageId: "ms:BOBS", mail: { to: [], subject: "", body: "x" } }, { env: env({}), getToken: h.getToken });
    assertEquals(h.asked, [undefined]);
  } finally { h.restore(); }
});

Deno.test("an explicit from_connection_id wins over the reply default and over the primary", async () => {
  const h = harness();
  try {
    const db = asClient(seed());
    await dispatchMail(db, { userId: "u1", fromConnectionId: "conn-b", mail: newMail }, { env: env({}), getToken: h.getToken });
    await dispatchMail(db, { userId: "u1", fromConnectionId: "conn-a", replyToMessageId: "ms:ON_B", mail: { to: [], subject: "", body: "x" } }, { env: env({}), getToken: h.getToken });
    assertEquals(h.asked, ["conn-b", "conn-a"]);
  } finally { h.restore(); }
});

Deno.test("another user's connection is refused (403 class) and nothing is sent", async () => {
  const h = harness();
  try {
    const err = await assertRejects(() => dispatchMail(asClient(seed()), { userId: "u1", fromConnectionId: "conn-x", mail: newMail }, { env: env({}), getToken: h.getToken }), MailSelectorError);
    assertEquals(err instanceof MailSelectorError, true);
    await assertRejects(() => dispatchMail(asClient(seed()), { userId: "u1", fromConnectionId: "no-such", mail: newMail }, { env: env({}), getToken: h.getToken }), MailSelectorError);
    assertEquals(h.asked, []);
    assertEquals(h.calls, []);
  } finally { h.restore(); }
});

Deno.test("resend path with two connections resolves Reply-To without maybeSingle, from the chosen mailbox, and stamps the log", async () => {
  const db = seed({
    organization_mail_settings: [{ organization_id: "o1", outbound_provider: "resend", resend_from_email: "c@mail.x.com", resend_from_name: "C", agent_senders: {} }],
    contacts: [{ id: "ct1", organization_id: "o1", email: "a@x.com", status: "active", department_id: null, first_name: "A", last_name: "X" }],
  });
  const sent: Array<Record<string, unknown>> = [];
  const resend = (o: unknown) => { sent.push(o as Record<string, unknown>); return Promise.resolve({ ok: true, status: 200, messageId: `rs_${sent.length}` }); };
  const e = env({ RESEND_API_KEY: "k" });
  await dispatchMail(asClient(db), { userId: "u1", mail: newMail }, { env: e, resend });
  await dispatchMail(asClient(db), { userId: "u1", fromConnectionId: "conn-b", mail: newMail }, { env: e, resend });
  assertEquals(sent.map((o) => o.replyTo), ["jordan@a.com", "jordan@b.com"]);
  const logged = db.rows("messages").filter((m) => String(m.external_id).startsWith("rs_"));
  assertEquals(logged.map((m) => m.mailbox_connection_id), ["conn-a", "conn-b"]);
  // a reply logged on the second mailbox is answered from it
  await dispatchMail(asClient(db), { userId: "u1", replyToMessageId: "ON_B", mail: { to: [], subject: "", body: "x" } }, { env: e, resend });
  assertEquals(sent[2].replyTo, "jordan@b.com");
  // another user's connection is refused here too
  await assertRejects(() => dispatchMail(asClient(db), { userId: "u1", fromConnectionId: "conn-x", mail: newMail }, { env: e, resend }), MailSelectorError);
});
