import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { INBOX_SYNC_SOURCE, parseGraphMessage, processGraphMessage, type GraphMessage } from "./ms-mail.ts";

const base: GraphMessage = {
  id: "AAA=",
  internetMessageId: "<x@y>",
  conversationId: "conv1",
  subject: "Hello",
  body: { contentType: "html", content: "<p>Hi&nbsp;there</p><style>p{}</style><br>Bye" },
  from: { emailAddress: { address: "Client@Example.com", name: "Client" } },
  toRecipients: [{ emailAddress: { address: "clara@example.org" } }],
  sentDateTime: "2026-10-15T12:00:00Z",
};

Deno.test("parse namespaces id, lowercases addresses, strips html", () => {
  const p = parseGraphMessage(base);
  assertEquals(p.externalId, "ms:AAA=");
  assertEquals(p.fromEmail, "client@example.com");
  assertEquals(p.body.includes("<"), false);
  assertEquals(p.body.includes("Hi there"), true);
});

// Minimal chainable fake: every query resolves to `result`; inserts are recorded.
function fake(tables: Record<string, { data?: unknown; error?: unknown }>, log: string[]) {
  const chain = (t: string) => {
    const r = tables[t] ?? { data: null };
    const c: Record<string, unknown> = {};
    for (const k of ["select", "eq", "neq", "ilike", "order", "limit", "update"]) c[k] = () => c;
    c.insert = (row: unknown) => { log.push(`${t}.insert`); void row; return c; };
    c.single = () => Promise.resolve({ data: r.data, error: r.error ?? null });
    c.maybeSingle = c.single;
    c.then = (res: (v: unknown) => unknown) => res({ data: r.data, error: r.error ?? null });
    return c;
  };
  return { from: chain } as never;
}
const ctx = { orgId: "o", userId: "u", mailboxEmail: "clara@example.org", syncSource: "t" };

Deno.test("drafts and unknown contacts are skipped without writing", async () => {
  const log: string[] = [];
  assertEquals((await processGraphMessage(fake({}, log), { ...base, isDraft: true }, ctx)).reason, "draft");
  const r = await processGraphMessage(fake({ messages: { data: null }, contacts: { data: null } }, log), base, ctx);
  assertEquals(r.reason, "not a known contact");
  assertEquals(log, []);
});

Deno.test("existing external_id is reported duplicate", async () => {
  const r = await processGraphMessage(fake({ messages: { data: { id: "m1" } } }, []), base, ctx);
  assertEquals(r.reason, "duplicate");
});

Deno.test("outbound counterpart is the first non-mailbox recipient", async () => {
  const out: GraphMessage = {
    ...base,
    from: { emailAddress: { address: "clara@example.org" } },
    toRecipients: [{ emailAddress: { address: "clara@example.org" } }, { emailAddress: { address: "buyer@x.com" } }],
  };
  // contact lookup returns null -> reason proves we got past counterpart detection
  const r = await processGraphMessage(fake({ messages: { data: null }, contacts: { data: null } }, []), out, ctx);
  assertEquals(r.reason, "not a known contact");
});

import { buildSendMailPayload } from "./ms-mail.ts";

Deno.test("send: owner is CC'd unless already a recipient", () => {
  const p = buildSendMailPayload({ to: ["Casey@x.com"], subject: "s", body: "b" }, "Owner@example.org");
  assertEquals(p.message.ccRecipients.map((r) => r.emailAddress.address), ["owner@example.org"]);
  const q = buildSendMailPayload({ to: ["owner@example.org"], subject: "s", body: "b" }, "owner@example.org");
  assertEquals(q.message.ccRecipients, []);
  const b = buildSendMailPayload({ to: ["a@x.com"], bcc: ["owner@example.org"], subject: "s", body: "b" }, "owner@example.org");
  assertEquals(b.message.ccRecipients, []);
});

Deno.test("send: rejects empty and malformed recipients", () => {
  let msg = "";
  try { buildSendMailPayload({ to: [], subject: "s", body: "b" }); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg.includes("at least one recipient"), true);
  try { buildSendMailPayload({ to: ["not-an-email"], subject: "s", body: "b" }); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg.includes("invalid address"), true);
});

Deno.test("a bounce for our own send raises one notification and is not stored as a message", async () => {
  const log: string[] = [];
  const ndr: GraphMessage = {
    id: "NDR1", subject: "Undeliverable: Hello", isDraft: false,
    from: { emailAddress: { address: "postmaster@exampleorg.onmicrosoft.com" } },
    toRecipients: [{ emailAddress: { address: "clara@example.org" } }],
    body: { contentType: "text", content: "Your message to a@gmail.com couldn't be delivered.\n550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP." },
  };
  const r = await processGraphMessage(fake({}, log), ndr, ctx);
  assertEquals(r.reason, "ndr");
  assertEquals(log, ["notifications.insert"]);
});

const CASEY = { id: "k1", organization_id: "o", email: "info@initechbox.com", status: "active", first_name: "Casey", last_name: "Sample", department_id: null };
const personal: GraphMessage = {
  ...base, id: "BBB=", internetMessageId: "<p@gmail>", subject: "circling back",
  from: { emailAddress: { address: "CaseySample@gmail.com", name: "Casey Sample" } },
  toRecipients: [{ emailAddress: { address: "jordan@example.org" } }],
};
const ownerBox = { orgId: "o", userId: "owner", mailboxEmail: "jordan@example.org", connectionId: "ms-owner" };

Deno.test("a client writing from an address that is not on their contact is no longer dropped silently", async () => {
  // live inbox feed: not stored on a name alone, but the owner is asked whose address it is
  const f = new FakeSupabase({ contacts: [CASEY] });
  const r = await processGraphMessage(asClient(f), personal, { ...ownerBox, syncSource: INBOX_SYNC_SOURCE });
  assertEquals([r.processed, r.reason, f.rows("messages").length], [false, "not a known contact", 0]);
  const s = f.rows("mail_sender_suggestions");
  assertEquals([s.length, s[0].email, s[0].contact_id, s[0].last_subject], [1, "caseysample@gmail.com", "k1", "circling back"]);

  // a history replay (contact backfill) never asks
  const g = new FakeSupabase({ contacts: [CASEY] });
  await processGraphMessage(asClient(g), personal, { ...ownerBox, syncSource: "contact_backfill" });
  assertEquals(g.rows("mail_sender_suggestions").length, 0);

  // our own sent mail to a stranger never asks either
  const h = new FakeSupabase({ contacts: [CASEY] });
  const sent: GraphMessage = { ...personal, from: { emailAddress: { address: "jordan@example.org", name: "Jordan Example" } }, toRecipients: [{ emailAddress: { address: "someone@new.com", name: "Casey Sample" } }] };
  await processGraphMessage(asClient(h), sent, { ...ownerBox, syncSource: INBOX_SYNC_SOURCE });
  assertEquals(h.rows("mail_sender_suggestions").length, 0);
});

Deno.test("once the address is on the contact, their mail is stored against them, in the mailbox it arrived in", async () => {
  const f = new FakeSupabase({ contacts: [CASEY], contact_emails: [{ organization_id: "o", contact_id: "k1", email: "caseysample@gmail.com" }] });
  const r = await processGraphMessage(asClient(f), personal, { ...ownerBox, syncSource: "contact_backfill" });
  assertEquals(r.processed, true);
  const m = f.rows("messages")[0];
  assertEquals([m.contact_id, m.direction, m.mailbox_connection_id, m.mailbox_email, (m.metadata as { from_email: string }).from_email], ["k1", "inbound", "ms-owner", "jordan@example.org", "caseysample@gmail.com"]);
  assertEquals(f.rows("mail_sender_suggestions").length, 0);
});
