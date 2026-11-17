import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  appendUnsubscribeHtml,
  EMPTY_DEFAULTS,
  loadOrgEmailDefaults,
  resolveSender,
  sendOrgEmail,
} from "./email-defaults.ts";
import { FakeSupabase } from "./testing/fake-supabase.ts";

const ORG = "org-1";
const ENV = { fromEmail: "platform@mail.example.com", fromName: "Platform" };

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeSupabase({
    email_defaults: [{
      org_id: ORG,
      default_from_address_id: "fa-1",
      default_reply_to: "replies@example.com",
      default_unsubscribe_group_id: "g-1",
      track_opens: true,
      track_clicks: false,
    }],
    email_from_addresses: [
      { id: "fa-1", org_id: ORG, email: "info@mail.example.com", display_name: "Example Co", reply_to: null, active: true, is_default: true },
      { id: "fa-2", org_id: ORG, email: "sales@mail.example.com", display_name: "Sales", reply_to: "sales-replies@example.com", active: true, is_default: false },
    ],
    email_unsubscribe_groups: [{ id: "g-1", org_id: ORG, name: "Marketing" }],
    suppressions: [],
    tracked_links: [],
    ...extra,
  }, { unique: { tracked_links: [["slug"]] } });
}

Deno.test("loadOrgEmailDefaults reads email_defaults by org_id + the default from address and group", async () => {
  const d = await loadOrgEmailDefaults(seed(), ORG);
  assertEquals(d.fromAddressId, "fa-1");
  assertEquals(d.fromEmail, "info@mail.example.com");
  assertEquals(d.fromName, "Example Co");
  assertEquals(d.defaultReplyTo, "replies@example.com");
  assertEquals(d.unsubscribeGroup, { id: "g-1", name: "Marketing" });
  assertEquals(d.trackClicks, false);
});

Deno.test("loadOrgEmailDefaults falls back to the is_default from address when email_defaults is empty", async () => {
  const db = seed({ email_defaults: [] });
  const d = await loadOrgEmailDefaults(db, ORG);
  assertEquals(d.fromEmail, "info@mail.example.com");
  assertEquals(d.unsubscribeGroup, null);
  assertEquals(d.trackOpens, true);
});

Deno.test("resolveSender: org default from, default reply-to fallback, caller overrides", () => {
  const d = { ...EMPTY_DEFAULTS, fromEmail: "info@mail.example.com", fromName: "Example Co", defaultReplyTo: "replies@example.com" };
  assertEquals(resolveSender(d, ENV, {}), { from: "info@mail.example.com", fromName: "Example Co", replyTo: "replies@example.com" });
  assertEquals(resolveSender(d, ENV, { replyTo: "me@x.com" }).replyTo, "me@x.com");
  assertEquals(resolveSender(d, ENV, { from: "Bot <bot@mail.example.com>" }).from, "bot@mail.example.com");
  assertEquals(resolveSender(d, ENV, { from: "Bot <bot@mail.example.com>" }).fromName, "Bot");
  // from address row reply_to beats the org default reply-to
  const row = { id: "fa-2", email: "sales@mail.example.com", display_name: "Sales", reply_to: "sales-replies@example.com" };
  assertEquals(resolveSender(d, ENV, { fromRow: row }).replyTo, "sales-replies@example.com");
  // nothing configured -> platform env sender
  assertEquals(resolveSender(EMPTY_DEFAULTS, ENV, {}), { from: ENV.fromEmail, fromName: ENV.fromName, replyTo: undefined });
});

Deno.test("appendUnsubscribeHtml places the footer before </body>", () => {
  const out = appendUnsubscribeHtml("<html><body><p>Hi</p></body></html>", "https://app.test/unsubscribe/abc", "Example Co");
  assert(out.indexOf("Unsubscribe") < out.indexOf("</body>"));
  assertStringIncludes(out, 'href="https://app.test/unsubscribe/abc"');
  assertStringIncludes(appendUnsubscribeHtml("<p>x</p>", "u"), "<p>x</p><div");
});

function withResendStub(fn: (calls: Array<Record<string, unknown>>) => Promise<void>) {
  return async () => {
    const calls: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const prev = {
      key: Deno.env.get("RESEND_API_KEY"),
      from: Deno.env.get("RESEND_FROM_EMAIL"),
      url: Deno.env.get("SUPABASE_URL"),
      app: Deno.env.get("APP_BASE_URL"),
    };
    Deno.env.set("RESEND_API_KEY", "test-key");
    Deno.env.set("RESEND_FROM_EMAIL", ENV.fromEmail);
    Deno.env.set("SUPABASE_URL", "https://proj.supabase.test");
    Deno.env.set("APP_BASE_URL", "https://app.test");
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(new Response(JSON.stringify({ id: `msg-${calls.length}` }), { status: 200 }));
    }) as typeof fetch;
    try {
      await fn(calls);
    } finally {
      globalThis.fetch = realFetch;
      const restore = (k: string, v: string | undefined) => (v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v));
      restore("RESEND_API_KEY", prev.key);
      restore("RESEND_FROM_EMAIL", prev.from);
      restore("SUPABASE_URL", prev.url);
      restore("APP_BASE_URL", prev.app);
    }
  };
}

Deno.test("sendOrgEmail applies defaults + List-Unsubscribe and reuses the recipient's slug", withResendStub(async (calls) => {
  const db = seed();
  const r1 = await sendOrgEmail(db, ORG, { to: "Lead@Example.com", subject: "Hi", html: "<p>Hi</p>" });
  assert(r1.ok);
  const p = calls[0];
  assertEquals(p.from, "Example Co <info@mail.example.com>");
  assertEquals(p.reply_to, "replies@example.com");
  const headers = p.headers as Record<string, string>;
  assertEquals(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assertStringIncludes(headers["List-Unsubscribe"], "https://proj.supabase.test/functions/v1/email-unsubscribe/");
  assertStringIncludes(String(p.html), "https://app.test/unsubscribe/");
  assertEquals(db.rows("tracked_links").length, 1);
  const meta = db.rows("tracked_links")[0].metadata as Record<string, unknown>;
  assertEquals(meta.email, "lead@example.com");
  assertEquals(meta.confirm, true);

  await sendOrgEmail(db, ORG, { to: "lead@example.com", subject: "Again", html: "<p>Again</p>" });
  assertEquals(db.rows("tracked_links").length, 1, "second send reuses the slug");
}));

Deno.test("sendOrgEmail: a contact's brand picks the brand sender; explicit senders and internal mail are untouched", withResendStub(async (calls) => {
  const db = seed({
    email_from_addresses: [
      { id: "fa-1", org_id: ORG, email: "info@mail.example.com", display_name: "Example Co", reply_to: null, active: true, is_default: true, brand: null },
      { id: "fa-acme", org_id: ORG, email: "notifications@mail.example.com", display_name: "Example Notifications", reply_to: null, active: true, is_default: false, brand: "default" },
      { id: "fa-sr", org_id: ORG, email: "clara@mail.other.com", display_name: "Clara Example", reply_to: "jordan@other.com", active: true, is_default: false, brand: "studio" },
    ],
    contacts: [
      { id: "c-sr", organization_id: ORG, brand: "studio" },
      { id: "c-acme", organization_id: ORG, brand: "default" },
      { id: "c-legacy", organization_id: ORG },
    ],
  });
  // studio contact -> Clara, even when the caller forwarded the org default display name
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, contactId: "c-sr", fromName: "Example Co" });
  assertEquals(calls[0].from, "Clara Example <clara@mail.other.com>");
  assertEquals(calls[0].reply_to, "jordan@other.com");
  // default-brand contact -> the brand's notifications sender, not the org default
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, contactId: "c-acme" });
  assertEquals(calls[1].from, "Example Notifications <notifications@mail.example.com>");
  // a contact without a brand column value falls back to the default brand
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, contactId: "c-legacy" });
  assertEquals(calls[2].from, "Example Notifications <notifications@mail.example.com>");
  // no contact (internal alert) -> org default
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true });
  assertEquals(calls[3].from, "Example Co <info@mail.example.com>");
  // explicit from address row wins over the brand
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, contactId: "c-sr", fromAddressId: "fa-1" });
  assertEquals(calls[4].from, "Example Co <info@mail.example.com>");
  // explicit brand without a contact
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, brand: "studio" });
  assertEquals(calls[5].from, "Clara Example <clara@mail.other.com>");
  // a caller's own display name is kept
  await sendOrgEmail(db, ORG, { to: "x@example.com", subject: "s", html: "<p>b</p>", transactional: true, contactId: "c-sr", fromName: "Support Desk" });
  assertEquals(calls[6].from, "Support Desk <clara@mail.other.com>");
}));

Deno.test("sendOrgEmail skips suppressed recipients unless transactional", withResendStub(async (calls) => {
  const db = seed({
    suppressions: [{ org_id: ORG, kind: "email", value_key: "gone@example.com", channel: "email", expires_at: null }],
  });
  const blocked = await sendOrgEmail(db, ORG, { to: "gone@example.com", subject: "Hi", html: "<p>Hi</p>" });
  assertEquals(blocked.ok, false);
  assertEquals(blocked.suppressed, true);
  assertEquals(calls.length, 0);

  const tx = await sendOrgEmail(db, ORG, { to: "gone@example.com", subject: "Booking", html: "<p>Booked</p>", transactional: true });
  assert(tx.ok);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].headers, undefined, "transactional mail carries no unsubscribe headers");
  assertEquals(db.rows("tracked_links").length, 0);
}));

Deno.test("sendOrgEmail with no default group sends without an unsubscribe link", withResendStub(async (calls) => {
  const db = seed({ email_unsubscribe_groups: [] });
  db.rows("email_defaults")[0].default_unsubscribe_group_id = null;
  const r = await sendOrgEmail(db, ORG, { to: "a@example.com", subject: "Hi", text: "Hi" });
  assert(r.ok);
  assertEquals(calls[0].headers, undefined);
  assertEquals(calls[0].text, "Hi");
}));
