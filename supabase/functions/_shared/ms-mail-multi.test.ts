import { assertEquals } from "jsr:@std/assert@1";
import { asClient, FakeSupabase } from "./testing/fake-supabase.ts";
import { nextConnectionId, processGraphMessage, syncMailConnections, type GraphMessage } from "./ms-mail.ts";

const CONTACT = { id: "ct1", organization_id: "o1", email: "client@example.com", status: "active", department_id: null, first_name: "Pat", last_name: "Client" };
const A = { id: "conn-a", user_id: "u1", organization_id: "o1", email: "jordan@a.com", is_primary: true, connection_status: "active" };
const B = { id: "conn-b", user_id: "u1", organization_id: "o1", email: "jordan@b.com", is_primary: false, connection_status: "active" };

const msg = (id: string, internet: string): GraphMessage => ({
  id, internetMessageId: internet, conversationId: "t1", subject: "Hello",
  body: { contentType: "text", content: "hi" }, from: { emailAddress: { address: "client@example.com" } },
  toRecipients: [{ emailAddress: { address: "jordan@a.com" } }, { emailAddress: { address: "jordan@b.com" } }],
  receivedDateTime: "2026-11-01T10:00:00Z",
});

/** Graph stand-in: the bearer token says which mailbox is being read. */
function graph(byToken: Record<string, GraphMessage[]>, urls: string[]) {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const tok = new Headers(init?.headers).get("Authorization")!.replace("Bearer ", "");
    urls.push(`${tok} ${u}`);
    const inbox = u.includes("/mailFolders/inbox/");
    const folder = inbox ? "inbox" : "sentitems";
    return Promise.resolve(new Response(JSON.stringify({
      value: inbox ? (byToken[tok] ?? []) : [], "@odata.deltaLink": `https://graph.microsoft.com/v1.0/delta/${tok}/${folder}`,
    }), { status: 200 }));
  }) as typeof fetch;
}

const getToken = (_u: string, id: string) => Promise.resolve(`tok-${id}`);

Deno.test("sync walks both connections of one user: separate delta links, mailbox stamped, shared mail stored once", async () => {
  const db = new FakeSupabase({ microsoft_oauth_master: [A, B], contacts: [CONTACT], outlook_sync_state: [], messages: [], conversations: [] });
  const urls: string[] = [];
  const { results } = await syncMailConnections(asClient(db), {
    cfg: null, getToken,
    fetchImpl: graph({ "tok-conn-a": [msg("A1", "<same@x>")], "tok-conn-b": [msg("B1", "<same@x>"), msg("B2", "<other@x>")] }, urls),
  });
  assertEquals(results.map((r) => [r.connection_id, r.processed]), [["conn-a", 1], ["conn-b", 1]]);

  const states = db.rows("outlook_sync_state");
  assertEquals(states.length, 2);
  const a = states.find((s) => s.connection_id === "conn-a")!, b = states.find((s) => s.connection_id === "conn-b")!;
  assertEquals((a.mail_delta_links as Record<string, string>).inbox, "https://graph.microsoft.com/v1.0/delta/tok-conn-a/inbox");
  assertEquals((b.mail_delta_links as Record<string, string>).inbox, "https://graph.microsoft.com/v1.0/delta/tok-conn-b/inbox");
  assertEquals(a.sync_status, "idle");

  const stored = db.rows("messages");
  assertEquals(stored.map((m) => [m.external_id, m.mailbox_connection_id, m.mailbox_email]).sort(), [
    ["ms:A1", "conn-a", "jordan@a.com"],
    ["ms:B2", "conn-b", "jordan@b.com"],
  ]);
  assertEquals((stored[0].metadata as Record<string, unknown>).internet_message_id, "<same@x>");

  // second run resumes each mailbox from ITS OWN link
  urls.length = 0;
  await syncMailConnections(asClient(db), { cfg: null, getToken, fetchImpl: graph({}, urls) });
  assertEquals(urls.includes("tok-conn-a https://graph.microsoft.com/v1.0/delta/tok-conn-a/inbox"), true);
  assertEquals(urls.includes("tok-conn-b https://graph.microsoft.com/v1.0/delta/tok-conn-b/inbox"), true);
});

Deno.test("sync runs the longest-idle mailbox first and honours the per-run cap", async () => {
  const db = new FakeSupabase({
    microsoft_oauth_master: [A, B], contacts: [CONTACT], messages: [], conversations: [],
    outlook_sync_state: [
      { id: "s1", user_id: "u1", organization_id: "o1", connection_id: "conn-a", mail_delta_links: {}, last_sync_at: "2026-11-05T00:00:00Z" },
      { id: "s2", user_id: "u1", organization_id: "o1", connection_id: "conn-b", mail_delta_links: {}, last_sync_at: "2026-11-01T00:00:00Z" },
    ],
  });
  const { results } = await syncMailConnections(asClient(db), { cfg: null, getToken, max: 1, fetchImpl: graph({}, []) });
  assertEquals(results.map((r) => r.connection_id), ["conn-b"]);
});

Deno.test("a legacy single-account user keeps working: the old state row is adopted and its delta link reused", async () => {
  const link = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old";
  const db = new FakeSupabase({
    microsoft_oauth_master: [A], contacts: [CONTACT], messages: [], conversations: [],
    outlook_sync_state: [{ id: "legacy", user_id: "u1", organization_id: "o1", connection_id: null, mail_delta_links: { inbox: link }, last_sync_at: null }],
  });
  const urls: string[] = [];
  const { results } = await syncMailConnections(asClient(db), { cfg: null, getToken, fetchImpl: graph({ "tok-conn-a": [msg("A1", "<m@x>")] }, urls) });
  assertEquals(results[0].processed, 1);
  assertEquals(urls[0], `tok-conn-a ${link}`);
  assertEquals(db.rows("outlook_sync_state").length, 1);
  assertEquals(db.rows("outlook_sync_state")[0].connection_id, "conn-a");
});

Deno.test("one failing mailbox is recorded on its own state and does not stop the next one", async () => {
  const db = new FakeSupabase({ microsoft_oauth_master: [A, B], contacts: [CONTACT], messages: [], conversations: [], outlook_sync_state: [] });
  const { results } = await syncMailConnections(asClient(db), {
    cfg: null, fetchImpl: graph({}, []),
    getToken: (_u, id) => id === "conn-a" ? Promise.reject(new Error("needs re-authorized")) : Promise.resolve(`tok-${id}`),
  });
  assertEquals(results.map((r) => "error" in r), [true, false]);
  assertEquals(db.rows("outlook_sync_state").find((s) => s.connection_id === "conn-a")!.sync_status, "error");
  assertEquals(db.rows("outlook_sync_state").find((s) => s.connection_id === "conn-b")!.sync_status, "idle");
});

Deno.test("a caller without a connection id (legacy path) neither stamps nor cross-dedupes", async () => {
  const db = new FakeSupabase({
    contacts: [CONTACT], conversations: [],
    messages: [{ id: "x", organization_id: "o1", external_id: "ms:OLD", metadata: { internet_message_id: "<same@x>" }, mailbox_connection_id: "conn-b" }],
  });
  const r = await processGraphMessage(asClient(db), msg("A1", "<same@x>"), { orgId: "o1", userId: "u1", mailboxEmail: "jordan@a.com", syncSource: "t" });
  assertEquals(r.processed, true);
  const row = db.rows("messages").find((m) => m.external_id === "ms:A1")!;
  assertEquals("mailbox_connection_id" in row, false);
});

Deno.test("the same mail re-seen in the SAME mailbox is not treated as another mailbox's copy", async () => {
  const db = new FakeSupabase({
    contacts: [CONTACT], conversations: [],
    messages: [{ id: "x", organization_id: "o1", external_id: "ms:INBOX1", metadata: { internet_message_id: "<same@x>" }, mailbox_connection_id: "conn-a" }],
  });
  const r = await processGraphMessage(asClient(db), msg("SENT1", "<same@x>"), { orgId: "o1", userId: "u1", mailboxEmail: "jordan@a.com", syncSource: "t", connectionId: "conn-a" });
  assertEquals(r.processed, true);
});

Deno.test("nextConnectionId walks the list and ends", () => {
  assertEquals(nextConnectionId(["a", "b"], null), "a");
  assertEquals(nextConnectionId(["a", "b"], "a"), "b");
  assertEquals(nextConnectionId(["a", "b"], "b"), null);
  assertEquals(nextConnectionId(["a", "b"], "gone"), null);
  assertEquals(nextConnectionId([], null), null);
});
