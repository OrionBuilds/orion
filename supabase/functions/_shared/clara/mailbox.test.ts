import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { MailboxError, gmailListUrl, graphMailUrls, readMailbox, type MailboxDeps } from "./mailbox.ts";

const ms = { user_id: "u", provider: "microsoft_365", provider_account_email: "u@corp.com", status: "connected" };
const gg = { user_id: "u", provider: "google_workspace", provider_account_email: "u@gmail.com", status: "connected" };

function deps(routes: Record<string, unknown>, log: string[] = []): MailboxDeps {
  return {
    fetch: ((url: string, init: RequestInit) => {
      log.push(`${new Headers(init.headers).get("Authorization")} ${url}`);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return Promise.resolve(new Response("{}", { status: 404 }));
      return Promise.resolve(hit[1] instanceof Response ? hit[1] : new Response(JSON.stringify(hit[1])));
    }) as unknown as typeof fetch,
    msToken: (u) => Promise.resolve(`ms-${u}`),
    googleToken: (u) => Promise.resolve(`g-${u}`),
  };
}

Deno.test("Graph URLs: inbox counts, newest unread first, or a search; top is passed through", () => {
  const u = graphMailUrls(5);
  assertEquals(u.folder, "https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount");
  assertEquals(decodeURIComponent(u.list).includes("/me/mailFolders/inbox/messages?$filter=isRead eq false&$orderby=receivedDateTime desc&$top=5"), true);
  const s = graphMailUrls(3, 'invoice "acme"');
  assertEquals(decodeURIComponent(s.list).includes('/me/messages?$search="invoice acme"&$top=3'), true);
  assertEquals(decodeURIComponent(gmailListUrl(4)), "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=4&q=in:inbox is:unread");
});

Deno.test("Microsoft: counts + top unread as metadata and a short preview; the owner's own token", async () => {
  const db = asClient(new FakeSupabase({ user_connected_accounts: [ms] }));
  const log: string[] = [];
  const long = "word ".repeat(200);
  const snap = await readMailbox(db, deps({
    "mailFolders/inbox?": { totalItemCount: 1200, unreadItemCount: 37 },
    "inbox/messages": { value: [{ subject: "Invoice", from: { emailAddress: { name: "Pat", address: "pat@acme.com" } }, receivedDateTime: "2026-10-28T12:00:00Z", bodyPreview: long, isRead: false, webLink: "https://outlook/x" }] },
  }, log), "u", { orgId: "o", top: 50 });
  assertEquals([snap!.provider, snap!.address, snap!.total, snap!.unread, snap!.listing], ["microsoft", "u@corp.com", 1200, 37, "unread"]);
  assertEquals(snap!.messages[0].from, "Pat <pat@acme.com>");
  assertEquals(snap!.messages[0].preview!.length <= 140, true);
  assertEquals(log.every((l) => l.startsWith("Bearer ms-u ")), true);
  assertEquals(log.some((l) => l.includes("$top=10")), true); // capped at 10
});

Deno.test("Google: INBOX label counts, unread list, metadata per message", async () => {
  const db = asClient(new FakeSupabase({ user_connected_accounts: [gg] }));
  const snap = await readMailbox(db, deps({
    "labels/INBOX": { messagesTotal: 500, messagesUnread: 4 },
    "messages?maxResults": { messages: [{ id: "m1" }] },
    "messages/m1": { id: "m1", snippet: "Hello there", labelIds: ["UNREAD", "INBOX"], internalDate: "1761652800000", payload: { headers: [{ name: "From", value: "Ann <ann@x.com>" }, { name: "Subject", value: "Hi" }] } },
  }), "u", { orgId: "o" });
  assertEquals([snap!.provider, snap!.total, snap!.unread, snap!.messages[0].from, snap!.messages[0].subject, snap!.messages[0].unread], ["google", 500, 4, "Ann <ann@x.com>", "Hi", true]);
});

Deno.test("provider choice: nothing connected = null; both connected follows the org default", async () => {
  assertEquals(await readMailbox(asClient(new FakeSupabase({})), deps({}), "u", { orgId: "o" }), null);
  const both = new FakeSupabase({
    user_connected_accounts: [ms, gg], users: [{ id: "u", organization_id: "o" }],
    organizations: [{ id: "o", default_workspace_provider: "google" }],
  });
  const log: string[] = [];
  const snap = await readMailbox(asClient(both), deps({ "labels/INBOX": { messagesTotal: 1, messagesUnread: 0 }, "messages?maxResults": {} }, log), "u", { orgId: "o" });
  assertEquals([snap!.provider, log[0].startsWith("Bearer g-u")], ["google", true]);
});

Deno.test("failures are reported, never swallowed into 'no mail'", async () => {
  const db = asClient(new FakeSupabase({ user_connected_accounts: [ms] }));
  await assertRejects(() => readMailbox(db, deps({ "mailFolders/inbox?": new Response("{}", { status: 401 }), "inbox/messages": { value: [] } }), "u", { orgId: "o" }), MailboxError, "401");
  const noToken = { ...deps({}), msToken: () => Promise.reject(new Error("needs re-authorization")) };
  await assertRejects(() => readMailbox(db, noToken, "u", { orgId: "o" }), MailboxError, "isn't usable");
});

import { resolveClaraConnection } from "./mailbox.ts";

const ownerConns = () => asClient(new FakeSupabase({ microsoft_oauth_master: [
  { id: "own-b", user_id: "owner", email: "jordan@b.com", is_primary: false },
  { id: "clara-a", user_id: "clara", email: "clara@x.com", is_primary: true },
  { id: "bob-a", user_id: "bob", email: "bob@x.com", is_primary: true },
] }));

Deno.test("Clara may send through the owner's connection or her own, nobody else's", async () => {
  const db = ownerConns();
  assertEquals((await resolveClaraConnection(db, ["clara", "owner"], "own-b")).userId, "owner");
  assertEquals((await resolveClaraConnection(db, ["clara", "owner"], "clara-a")).userId, "clara");
  await assertRejects(() => resolveClaraConnection(db, ["clara", "owner"], "bob-a"), MailboxError, "owner's mailboxes or her own");
  await assertRejects(() => resolveClaraConnection(db, ["clara", null], "own-b"), MailboxError, "owner's mailboxes or her own");
  await assertRejects(() => resolveClaraConnection(db, ["clara", "owner"], "nope"), MailboxError, "isn't connected");
});

Deno.test("reading a mailbox with a chosen account uses that connection's token; another user's connection is refused", async () => {
  const db = asClient(new FakeSupabase({
    user_connected_accounts: [{ user_id: "u", provider: "microsoft_365", provider_account_email: "p@x.com" }],
    microsoft_oauth_master: [
      { id: "c1", user_id: "u", email: "p@x.com", is_primary: true }, { id: "c2", user_id: "u", email: "second@x.com", is_primary: false },
      { id: "cx", user_id: "other", email: "o@x.com", is_primary: true },
    ],
  }));
  const asked: Array<string | undefined> = [];
  const d: MailboxDeps = { ...deps({ "mailFolders/inbox?": { totalItemCount: 1, unreadItemCount: 0 }, "inbox/messages": { value: [] } }), msToken: (_u, c) => { asked.push(c); return Promise.resolve("t"); } };
  const snap = await readMailbox(db, d, "u", { orgId: "o", prefer: "microsoft", connectionId: "c2" });
  assertEquals(snap?.address, "second@x.com");
  await readMailbox(db, d, "u", { orgId: "o", prefer: "microsoft" });
  assertEquals(asked, ["c2", undefined]);
  await assertRejects(() => readMailbox(db, d, "u", { orgId: "o", prefer: "microsoft", connectionId: "cx" }), MailboxError, "isn't connected");
});

Deno.test("Google: the primary account by default; a chosen account's own token; another user's account is refused", async () => {
  const db = asClient(new FakeSupabase({
    user_connected_accounts: [gg],
    google_oauth_master: [
      { id: "g1", user_id: "u", email: "u@gmail.com", is_primary: true, created_at: "2026-01-01" },
      { id: "g2", user_id: "u", email: "second@corp.com", is_primary: false, created_at: "2026-01-02" },
      { id: "gx", user_id: "other", email: "o@gmail.com", is_primary: true, created_at: "2026-01-01" },
    ],
  }));
  const asked: Array<string | undefined> = [];
  const d: MailboxDeps = { ...deps({ "labels/INBOX": { messagesTotal: 1, messagesUnread: 0 }, "messages?maxResults": {} }), googleToken: (_u, c) => { asked.push(c); return Promise.resolve("t"); } };
  const snap = await readMailbox(db, d, "u", { orgId: "o", prefer: "google", connectionId: "g2" });
  assertEquals(snap?.address, "second@corp.com");
  await readMailbox(db, d, "u", { orgId: "o", prefer: "google" });
  assertEquals(asked, ["g2", undefined]);
  await assertRejects(() => readMailbox(db, d, "u", { orgId: "o", prefer: "google", connectionId: "gx" }), MailboxError, "isn't connected");
});
