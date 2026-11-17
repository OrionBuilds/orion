import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { buildResendOptions, dispatchMail, parseMailSettings, pickSender, resolveRecipients } from "./mail-dispatch.ts";

// A tiny chainable fake of the supabase client: reads return `tables[name]`, inserts are recorded.
function fakeDb(tables: Record<string, unknown>) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      for (const m of ["select", "eq", "in", "ilike", "neq", "order", "limit"]) q[m] = chain;
      q.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
      // a user's connections are read as a list (never maybeSingle on several rows)
      if (table === "microsoft_oauth_master" && tables[table]) q.then = (f: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: "c1", is_primary: true, ...(tables[table] as object) }], error: null }).then(f);
      q.single = () => Promise.resolve({ data: tables[table] ?? null, error: null });
      q.insert = (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        const r = { select: () => ({ single: () => Promise.resolve({ data: { id: "new-conv" }, error: null }) }), then: (f: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(f) };
        return r;
      };
      q.update = () => ({ eq: () => Promise.resolve({ error: null }) });
      return q;
    },
  };
  return { db: db as never, inserts };
}

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });
const USER = { organization_id: "org1", email: "clara@example.org", name: "Clara Example" };

Deno.test("an org with no settings row, or microsoft, uses Graph (default is unchanged)", async () => {
  const { db } = fakeDb({ users: USER });
  let tokenFor = "";
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => { calls.push(String(url)); return Promise.resolve(new Response("", { status: 202 })); }) as typeof fetch;
  try {
    const r = await dispatchMail(db, { userId: "u1", mail: { to: ["a@x.com"], subject: "s", body: "b" }, ownerEmail: "owner@x.com" },
      { env: env({}), getToken: (_d, u) => { tokenFor = u; return Promise.resolve("tok"); } });
    assertEquals(r.provider, "microsoft");
    assertEquals(tokenFor, "u1");
    assertEquals(calls.some((c) => c.includes("/me/sendMail")), true);
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("resend org: sends via Resend with sender, reply-to, owner CC and logs the message", async () => {
  const { db, inserts } = fakeDb({
    users: USER,
    organization_mail_settings: { outbound_provider: "resend", resend_from_email: "clara@mail.example.org", resend_from_name: "Clara Example", agent_senders: {} },
    microsoft_oauth_master: { email: "clara@example.org" },
    contacts: { id: "ct1", department_id: null, first_name: "Pat", last_name: "Client" },
    conversations: { id: "conv1" },
  });
  let sent: Record<string, unknown> | null = null;
  const r = await dispatchMail(db, { userId: "u1", mail: { to: ["Pat@Client.com"], subject: "Hi", body: "Hello <b>there</b>" }, ownerEmail: "owner@x.com" },
    { env: env({ RESEND_API_KEY: "re_key" }), resend: (o) => { sent = o as unknown as Record<string, unknown>; return Promise.resolve({ ok: true, status: 200, messageId: "rs_1" }); } });
  assertEquals(r.provider, "resend");
  assertEquals(r.messageId, "rs_1");
  assertEquals(r.logged, true);
  const o = sent as unknown as Record<string, unknown>;
  assertEquals(o.from, "clara@mail.example.org");
  assertEquals(o.replyTo, "clara@example.org");
  assertEquals(o.to, ["pat@client.com"]);
  assertEquals(o.cc, ["owner@x.com"]);
  assertEquals(o.html, '<div style="white-space:pre-wrap">Hello &lt;b&gt;there&lt;/b&gt;</div>');
  assertEquals((o.customArgs as Record<string, string>).orion_user, "u1");
  const msg = inserts.find((i) => i.table === "messages")!.row;
  assertEquals(msg.external_id, "rs_1");
  assertEquals(msg.direction, "outbound");
  assertEquals((msg.metadata as Record<string, unknown>).provider, "resend");
});

Deno.test("resend org: a missing key or sender refuses instead of guessing", async () => {
  const base = { users: USER, microsoft_oauth_master: { email: "c@x.com" } };
  const a = fakeDb({ ...base, organization_mail_settings: { outbound_provider: "resend", resend_from_email: "c@mail.x.com" } });
  await assertRejects(() => dispatchMail(a.db, { userId: "u1", mail: { to: ["a@x.com"], subject: "s", body: "b" } }, { env: env({}) }), Error, "RESEND_API_KEY");
  const b = fakeDb({ ...base, organization_mail_settings: { outbound_provider: "resend" } });
  await assertRejects(() => dispatchMail(b.db, { userId: "u1", mail: { to: ["a@x.com"], subject: "s", body: "b" } }, { env: env({ RESEND_API_KEY: "k" }) }), Error, "No Resend sender");
});

Deno.test("resend failure surfaces as an error (nothing is logged as sent)", async () => {
  const { db, inserts } = fakeDb({ users: USER, organization_mail_settings: { outbound_provider: "resend", resend_from_email: "c@mail.x.com" }, microsoft_oauth_master: { email: "c@x.com" } });
  await assertRejects(() => dispatchMail(db, { userId: "u1", mail: { to: ["a@x.com"], subject: "s", body: "b" } },
    { env: env({ RESEND_API_KEY: "k" }), resend: () => Promise.resolve({ ok: false, status: 422, error: "domain not verified" }) }), Error, "domain not verified");
  assertEquals(inserts.length, 0);
});

Deno.test("resend reply: answers the logged message in-thread with Re: and In-Reply-To", async () => {
  const { db } = fakeDb({
    users: USER, organization_mail_settings: { outbound_provider: "resend", resend_from_email: "c@mail.x.com" }, microsoft_oauth_master: { email: "clara@example.org" },
    messages: { subject: "Quote", direction: "inbound", metadata: { from_email: "pat@client.com", rfc_message_id: "<abc@client.com>" } },
  });
  let sent: Record<string, unknown> | null = null;
  await dispatchMail(db, { userId: "u1", replyToMessageId: "ms:AAA", mail: { to: [], subject: "", body: "Thanks" } },
    { env: env({ RESEND_API_KEY: "k" }), resend: (o) => { sent = o as unknown as Record<string, unknown>; return Promise.resolve({ ok: true, status: 200, messageId: "rs_2" }); } });
  const o = sent as unknown as Record<string, unknown>;
  assertEquals(o.to, ["pat@client.com"]);
  assertEquals(o.subject, "Re: Quote");
  assertEquals((o.customHeaders as Record<string, string>)["In-Reply-To"], "<abc@client.com>");
});

Deno.test("resend reply to a message that isn't logged is refused", async () => {
  const { db } = fakeDb({ users: USER, organization_mail_settings: { outbound_provider: "resend", resend_from_email: "c@mail.x.com" }, microsoft_oauth_master: { email: "c@x.com" } });
  await assertRejects(() => dispatchMail(db, { userId: "u1", replyToMessageId: "ZZZ", mail: { to: [], subject: "", body: "x" } }, { env: env({ RESEND_API_KEY: "k" }) }), Error, "isn't in the log");
});

Deno.test("owner CC: added once, never when already a recipient; bad addresses rejected", () => {
  assertEquals(resolveRecipients({ to: ["A@x.com", "a@x.com"], subject: "", body: "" }, "o@x.com"), { to: ["a@x.com"], cc: ["o@x.com"], bcc: [] });
  assertEquals(resolveRecipients({ to: ["o@x.com"], subject: "", body: "" }, "O@x.com").cc, []);
  assertEquals(resolveRecipients({ to: ["a@x.com"], cc: ["o@x.com"], subject: "", body: "" }, "o@x.com").cc, ["o@x.com"]);
  try { resolveRecipients({ to: ["nope"], subject: "", body: "" }); throw new Error("no throw"); } catch (e) { assertEquals((e as Error).message, "sendMail: invalid address: nope"); }
  try { resolveRecipients({ to: [], subject: "", body: "" }); throw new Error("no throw"); } catch (e) { assertEquals((e as Error).message, "sendMail: at least one recipient is required"); }
});

Deno.test("settings: default microsoft; per-user sender overrides the org default", () => {
  assertEquals(parseMailSettings(null).provider, "microsoft");
  assertEquals(parseMailSettings({ outbound_provider: "bogus" }).provider, "microsoft");
  const s = parseMailSettings({ outbound_provider: "resend", resend_from_email: "org@mail.x.com", resend_from_name: "Org", agent_senders: { u2: { email: "fri@mail.x.com", name: "Friday" } } });
  assertEquals(pickSender(s, "u1", "Clara"), { email: "org@mail.x.com", name: "Org" });
  assertEquals(pickSender(s, "u2", "F"), { email: "fri@mail.x.com", name: "Friday" });
  assertEquals(pickSender(parseMailSettings({ outbound_provider: "resend" }), "u1", "Clara"), null);
});

Deno.test("plain text bodies get an escaped HTML part; html bodies pass through; key is not in the tags", () => {
  const o = buildResendOptions({ mail: { to: ["a@x.com"], subject: "s", body: "<p>hi</p>", contentType: "html" } }, { email: "c@m.x.com", name: null }, null, "re_secret", { orion_user: "u" });
  assertEquals(o.html, "<p>hi</p>");
  assertEquals(o.text, undefined);
  assertEquals(JSON.stringify(o.customArgs).includes("re_secret"), false);
});
