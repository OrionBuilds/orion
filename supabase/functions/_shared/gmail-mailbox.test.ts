import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import {
  belongsToMailbox, claimSyncLock, enqueueDueIncrementalJobs, fetchAcrossMailboxes, findSyncState, getMailboxToken, listGmailMailboxes,
  mailboxForState, mapPushToMailbox, MailboxSelectError, pickMailbox, resolveApiMailbox, resolveGmailMailbox, resolveJobMailbox,
  saveSyncState, markInitialJobsDone,
} from "./gmail-mailbox.ts";

const ORG = "o1", U = "u1";
const future = new Date(Date.now() + 3600_000).toISOString();

/** u1 has a primary (a) and a second account (b), both with Gmail; u2 is another user. */
function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeSupabase({
    google_oauth_master: [
      { id: "a", user_id: U, org_id: ORG, email: "a@x.com", is_primary: true, connection_status: "active", encrypted_access_token: "tokA", encrypted_refresh_token: "refA", token_expiry: future, created_at: "2026-01-01" },
      { id: "b", user_id: U, org_id: ORG, email: "B@y.com", is_primary: false, connection_status: "active", encrypted_access_token: "tokB", encrypted_refresh_token: "refB", token_expiry: future, created_at: "2026-01-02" },
      { id: "c", user_id: "u2", org_id: ORG, email: "c@z.com", is_primary: true, connection_status: "active", encrypted_access_token: "tokC", encrypted_refresh_token: "refC", token_expiry: future, created_at: "2026-01-03" },
    ],
    gmail_oauth_tokens: [
      { id: "ta", organization_id: ORG, user_id: U, connection_id: "a", email: "a@x.com", created_at: "2026-01-01" },
      { id: "tb", organization_id: ORG, user_id: U, connection_id: "b", email: "B@y.com", created_at: "2026-01-02" },
      { id: "tc", organization_id: ORG, user_id: "u2", connection_id: "c", email: "c@z.com", created_at: "2026-01-03" },
    ],
    ...extra,
  });
}
const mbA = { connectionId: "a", userId: U, orgId: ORG, email: "a@x.com", isPrimary: true };
const mbB = { connectionId: "b", userId: U, orgId: ORG, email: "B@y.com", isPrimary: false };

Deno.test("mailboxes: both accounts listed primary first; a legacy token row without a connection id is the primary's", async () => {
  const db = asClient(seed());
  assertEquals((await listGmailMailboxes(db, U, ORG)).map((m) => [m.connectionId, m.isPrimary]), [["a", true], ["b", false]]);

  const legacy = asClient(new FakeSupabase({
    google_oauth_master: [{ id: "a", user_id: U, org_id: ORG, email: "a@x.com", is_primary: true, created_at: "2026-01-01" }],
    gmail_oauth_tokens: [{ id: "t", organization_id: ORG, user_id: U, connection_id: null, email: "something-else@x.com" }],
  }));
  assertEquals((await listGmailMailboxes(legacy, U, ORG)).map((m) => m.connectionId), ["a"]);
  // a Google account with no Gmail token row is not a mailbox
  const noGmail = asClient(new FakeSupabase({ google_oauth_master: [{ id: "a", user_id: U, email: "a@x.com", is_primary: true }], gmail_oauth_tokens: [] }));
  assertEquals(await listGmailMailboxes(noGmail, U, ORG), []);
});

Deno.test("pick/resolve: default primary, by id or email, never another user's account", async () => {
  const db = asClient(seed());
  assertEquals((await resolveGmailMailbox(db, U, ORG))?.connectionId, "a");
  assertEquals((await resolveGmailMailbox(db, U, ORG, { connectionId: "b" }))?.connectionId, "b");
  assertEquals((await resolveGmailMailbox(db, U, ORG, { email: "b@Y.com" }))?.connectionId, "b");
  assertEquals(await resolveGmailMailbox(db, U, ORG, { connectionId: "c" }), null);
  assertEquals(pickMailbox([], {}), null);
});

Deno.test("token: each mailbox gets its own token; an account needing re-auth fails alone", async () => {
  const f = seed();
  const db = asClient(f);
  assertEquals(await getMailboxToken(db, mbA), "tokA");
  assertEquals(await getMailboxToken(db, mbB), "tokB");
  f.rows("google_oauth_master").find((r) => r.id === "b")!.connection_status = "needs_reauth";
  await assertRejects(() => getMailboxToken(db, mbB), Error, "re-authorized");
  assertEquals(await getMailboxToken(db, mbA), "tokA");
});

Deno.test("sync state: history id, watch and lock are per mailbox", async () => {
  const f = seed();
  const db = asClient(f);
  await saveSyncState(db, mbA, { sync_status: "idle", history_id: "100", watch_expiration: "w1" });
  await saveSyncState(db, mbB, { sync_status: "idle", history_id: "200", watch_expiration: "w2" });
  assertEquals(f.rows("gmail_sync_state").length, 2);
  assertEquals((await findSyncState(db, mbA))?.history_id, "100");
  assertEquals((await findSyncState(db, mbB))?.history_id, "200");

  // B's lock and update never touch A
  assertEquals(await claimSyncLock(db, mbB), true);
  assertEquals(await claimSyncLock(db, mbB), false);
  assertEquals((await findSyncState(db, mbA))?.sync_status, "idle");
  await saveSyncState(db, mbB, { history_id: "250", sync_status: "idle" });
  assertEquals([(await findSyncState(db, mbA))?.history_id, (await findSyncState(db, mbB))?.history_id], ["100", "250"]);
  assertEquals(await claimSyncLock(db, mbA), true);
});

Deno.test("sync state: a legacy row (no connection id) is adopted by the primary only", async () => {
  const f = seed({ gmail_sync_state: [{ id: "s", organization_id: ORG, user_id: U, connection_id: null, history_id: "77", sync_status: "idle" }] });
  const db = asClient(f);
  assertEquals(await findSyncState(db, mbB), null);
  assertEquals((await findSyncState(db, mbA))?.history_id, "77");
  await saveSyncState(db, mbA, { history_id: "78" });
  assertEquals(f.rows("gmail_sync_state").length, 1);
  assertEquals([f.rows("gmail_sync_state")[0].connection_id, f.rows("gmail_sync_state")[0].history_id], ["a", "78"]);
});

Deno.test("incremental jobs: one per mailbox, none while one is in flight, legacy rows count for the primary", async () => {
  const f = seed({
    gmail_sync_state: [
      { id: "s1", organization_id: ORG, user_id: U, connection_id: "a", history_id: "1", sync_status: "idle" },
      { id: "s2", organization_id: ORG, user_id: U, connection_id: "b", history_id: "2", sync_status: "idle" },
      { id: "s3", organization_id: ORG, user_id: "u2", connection_id: null, history_id: "3", sync_status: "idle" },
      { id: "s4", organization_id: ORG, user_id: U, connection_id: "b", history_id: null, sync_status: "idle" },
    ],
    gmail_sync_jobs: [{ id: "j", organization_id: ORG, user_id: U, connection_id: null, job_type: "incremental", status: "queued" }],
  });
  const db = asClient(f);
  // the legacy queued job covers the primary (a); b and u2's legacy primary c need one each
  assertEquals(await enqueueDueIncrementalJobs(db), 2);
  assertEquals(f.rows("gmail_sync_jobs").filter((j) => j.id !== "j").map((j) => [j.user_id, j.connection_id, j.job_type]).sort(), [["u1", "b", "incremental"], ["u2", "c", "incremental"]]);
  assertEquals(await enqueueDueIncrementalJobs(db), 0);
});

Deno.test("jobs: a connection id runs on that mailbox; a legacy job runs on the primary and a legacy backfill fans out to the others", async () => {
  const f = seed({ gmail_sync_jobs: [
    { id: "j1", organization_id: ORG, user_id: U, connection_id: "b", job_type: "incremental" },
    { id: "j2", organization_id: ORG, user_id: U, connection_id: null, job_type: "contact_backfill", payload: { email: "Pat@acme.com", contact_id: "k" } },
    { id: "j3", organization_id: ORG, user_id: U, connection_id: "gone", job_type: "incremental" },
  ] });
  const db = asClient(f);
  assertEquals((await resolveJobMailbox(db, f.rows("gmail_sync_jobs")[0]))?.connectionId, "b");
  assertEquals(await resolveJobMailbox(db, f.rows("gmail_sync_jobs")[2]), null);
  assertEquals((await resolveJobMailbox(db, f.rows("gmail_sync_jobs")[1]))?.connectionId, "a");
  const backfills = f.rows("gmail_sync_jobs").filter((j) => j.job_type === "contact_backfill");
  assertEquals(backfills.map((j) => j.connection_id).sort(), ["a", "b"]);
  assertEquals((backfills.find((j) => j.connection_id === "b")!.payload as Record<string, unknown>).email, "Pat@acme.com");
  // running the same legacy job again does not queue a duplicate
  await resolveJobMailbox(db, { ...f.rows("gmail_sync_jobs")[1], connection_id: null });
  assertEquals(f.rows("gmail_sync_jobs").filter((j) => j.job_type === "contact_backfill").length, 2);
});

Deno.test("first-sync job completion only closes the finished mailbox's job", async () => {
  const f = seed({ gmail_sync_jobs: [
    { id: "ja", organization_id: ORG, user_id: U, connection_id: "a", job_type: "initial", status: "running" },
    { id: "jb", organization_id: ORG, user_id: U, connection_id: "b", job_type: "initial", status: "running" },
  ] });
  await markInitialJobsDone(asClient(f), mbB);
  assertEquals(f.rows("gmail_sync_jobs").map((j) => [j.id, j.status]), [["ja", "running"], ["jb", "done"]]);
  assertEquals([belongsToMailbox(null, mbA), belongsToMailbox(null, mbB), belongsToMailbox("b", mbB)], [true, false, true]);
});

Deno.test("watch renewal: a state row maps to its own connection; legacy maps to the primary", async () => {
  const db = asClient(seed());
  assertEquals((await mailboxForState(db, { organization_id: ORG, user_id: U, connection_id: "b" }))?.email, "B@y.com");
  assertEquals((await mailboxForState(db, { organization_id: ORG, user_id: U, connection_id: null }))?.connectionId, "a");
  assertEquals(await mailboxForState(db, { organization_id: ORG, user_id: U, connection_id: "zzz" }), null);
});

Deno.test("push: the pushed address maps to its own connection, any case; the oldest wins when two users share it", async () => {
  const f = seed();
  const db = asClient(f);
  const r = await mapPushToMailbox(db, "b@y.COM");
  assertEquals([r?.mailbox.connectionId, r?.mailbox.userId, r?.candidates], ["b", U, 1]);
  assertEquals((await mapPushToMailbox(db, "a@x.com"))?.mailbox.connectionId, "a");
  assertEquals(await mapPushToMailbox(db, "nobody@x.com"), null);

  // a shared mailbox connected by a second OS user
  f.rows("google_oauth_master").push({ id: "d", user_id: "u3", org_id: ORG, email: "a@x.com", is_primary: true, created_at: "2026-02-01" });
  f.rows("gmail_oauth_tokens").push({ id: "td", organization_id: ORG, user_id: "u3", connection_id: "d", email: "a@x.com", created_at: "2026-02-01" });
  const shared = await mapPushToMailbox(db, "A@x.com");
  assertEquals([shared?.mailbox.userId, shared?.mailbox.connectionId, shared?.candidates], [U, "a", 2]);
});

Deno.test("gmail-api mailbox: primary by default, an explicit account must be the caller's, a reply uses the arrival mailbox", async () => {
  const f = seed({ messages: [
    { id: "m1", organization_id: ORG, metadata: { thread_id: "T-b" }, mailbox_google_connection_id: "b", sent_at: "2026-03-01" },
    { id: "m2", organization_id: ORG, metadata: { thread_id: "T-c" }, mailbox_google_connection_id: "c", sent_at: "2026-03-01" },
    { id: "m3", organization_id: ORG, metadata: { thread_id: "T-legacy" }, mailbox_google_connection_id: null, sent_at: "2026-03-01" },
  ] });
  const db = asClient(f);
  assertEquals((await resolveApiMailbox(db, U, ORG, {})).connectionId, "a");
  assertEquals((await resolveApiMailbox(db, U, ORG, { connectionId: "b" })).connectionId, "b");
  const foreign = await resolveApiMailbox(db, U, ORG, { connectionId: "c" }).catch((e) => e);
  assertEquals([foreign instanceof MailboxSelectError, foreign.status], [true, 403]);
  // a reply: the account the thread arrived on, only if it is the caller's, else the primary
  assertEquals((await resolveApiMailbox(db, U, ORG, { replyThreadId: "T-b" })).connectionId, "b");
  assertEquals((await resolveApiMailbox(db, U, ORG, { replyThreadId: "T-c" })).connectionId, "a");
  assertEquals((await resolveApiMailbox(db, U, ORG, { replyThreadId: "T-legacy" })).connectionId, "a");
  assertEquals((await resolveApiMailbox(db, U, ORG, { replyThreadId: "T-b", connectionId: "a" })).connectionId, "a");
  // no Gmail at all
  const none = await resolveApiMailbox(asClient(new FakeSupabase()), U, ORG, {}).catch((e) => e);
  assertEquals([none.status, none.message], [400, "Gmail not connected"]);
});

Deno.test("reading across mailboxes: a 404 on the chosen mailbox falls back to the caller's other account, then the org's", async () => {
  const f = seed();
  const db = asClient(f);
  const tried: string[] = [];
  const getToken = (_u: string, sel: { connectionId?: string | null; email?: string | null }) => Promise.resolve(`tok-${sel.connectionId ?? sel.email}`);
  const doFetch = (holder: string) => (t: string) => { tried.push(t); return Promise.resolve(new Response("{}", { status: t === holder ? 200 : 404 })); };

  assertEquals((await fetchAcrossMailboxes(db, mbA, "tok-a", doFetch("tok-a"), getToken)).ok, true);
  assertEquals(tried, ["tok-a"]);
  tried.length = 0;
  assertEquals((await fetchAcrossMailboxes(db, mbA, "tok-a", doFetch("tok-c"), getToken)).ok, true);
  assertEquals(tried, ["tok-a", "tok-b", "tok-c"]);   // own other account before a teammate's, never the same mailbox twice
  tried.length = 0;
  assertEquals((await fetchAcrossMailboxes(db, mbA, "tok-a", doFetch("nobody"), getToken)).status, 404);
  // a 401 is a real failure, not a wrong-mailbox signal
  tried.length = 0;
  assertEquals((await fetchAcrossMailboxes(db, mbA, "tok-a", (t) => { tried.push(t); return Promise.resolve(new Response("{}", { status: 401 })); }, getToken)).status, 401);
  assertEquals(tried, ["tok-a"]);
});
