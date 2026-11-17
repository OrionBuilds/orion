import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { encodeBase64Url, isInboxMail, processGmailMessage } from "./gmail-helpers.ts";

const ORG = "o1", U = "u1";

function gmailMsg(o: { id: string; from: string; to: string; rfc: string; labels?: string[]; thread?: string }) {
  return {
    id: o.id, threadId: o.thread ?? "T1", labelIds: o.labels ?? ["INBOX"], snippet: "hi", internalDate: String(Date.parse("2026-11-08T10:00:00Z")),
    payload: {
      mimeType: "text/plain", body: { data: encodeBase64Url("hello") },
      headers: [
        { name: "From", value: o.from }, { name: "To", value: o.to }, { name: "Subject", value: "Hi" },
        { name: "Date", value: "Sun, 08 Nov 2026 10:00:00 +0000" }, { name: "Message-ID", value: o.rfc },
      ],
    },
  };
}
const seed = () => new FakeSupabase({ contacts: [{ id: "k1", organization_id: ORG, email: "pat@acme.com", status: "active", first_name: "Pat", last_name: "A" }] });

Deno.test("a synced message is stamped with the mailbox it arrived on", async () => {
  const f = seed();
  const r = await processGmailMessage(asClient(f), gmailMsg({ id: "g1", from: "Pat <pat@acme.com>", to: "me@b.com", rfc: "<r1@x>" }), ORG, U, { connectionId: "conn-b", email: "me@b.com" }, "push");
  assertEquals(r.processed, true);
  const m = f.rows("messages")[0];
  assertEquals([m.mailbox_google_connection_id, m.mailbox_email, m.direction, m.external_id], ["conn-b", "me@b.com", "inbound", "g1"]);
});

Deno.test("direction is judged against THIS mailbox's address (the other account's address is just a contact)", async () => {
  const f = seed();
  // sent from the second account to a contact
  await processGmailMessage(asClient(f), gmailMsg({ id: "g2", from: "me@b.com", to: "pat@acme.com", rfc: "<r2@x>", labels: ["SENT"] }), ORG, U, { connectionId: "conn-b", email: "me@b.com" }, "push");
  assertEquals(f.rows("messages")[0].direction, "outbound");
  // read in the primary's mailbox, a message from the second account's address is inbound mail from that address
  const g = new FakeSupabase({ contacts: [{ id: "k2", organization_id: ORG, email: "me@b.com", status: "active", first_name: "M", last_name: "B" }] });
  await processGmailMessage(asClient(g), gmailMsg({ id: "g3", from: "me@b.com", to: "a@x.com", rfc: "<r3@x>" }), ORG, U, { connectionId: "conn-a", email: "a@x.com" }, "push");
  assertEquals(g.rows("messages")[0].direction, "inbound");
});

Deno.test("the same RFC message reaching a second mailbox is stored once (first mailbox wins)", async () => {
  const f = seed();
  const db = asClient(f);
  const first = await processGmailMessage(db, gmailMsg({ id: "ga", from: "pat@acme.com", to: "a@x.com", rfc: "<same@x>" }), ORG, U, { connectionId: "conn-a", email: "a@x.com" }, "push");
  const second = await processGmailMessage(db, gmailMsg({ id: "gb", from: "pat@acme.com", to: "b@y.com", rfc: "<same@x>" }), ORG, "u2", { connectionId: "conn-b", email: "b@y.com" }, "push");
  assertEquals([first.processed, second.processed, second.duplicate], [true, false, true]);
  assertEquals(f.rows("messages").length, 1);
  assertEquals(f.rows("messages")[0].mailbox_google_connection_id, "conn-a");
  assertEquals(f.rows("conversations").length, 1);
  // a different RFC message, or the same id in another org, is not a duplicate
  await processGmailMessage(db, gmailMsg({ id: "gc", from: "pat@acme.com", to: "b@y.com", rfc: "<other@x>" }), ORG, "u2", { connectionId: "conn-b", email: "b@y.com" }, "push");
  assertEquals(f.rows("messages").length, 2);
});

Deno.test("legacy callers passing only an address still work (no mailbox stamp id)", async () => {
  const f = seed();
  await processGmailMessage(asClient(f), gmailMsg({ id: "g9", from: "pat@acme.com", to: "me@b.com", rfc: "<r9@x>" }), ORG, U, "me@b.com", "push");
  const m = f.rows("messages")[0];
  assertEquals([m.mailbox_google_connection_id, m.mailbox_email], [null, "me@b.com"]);
});

Deno.test("mail from a contact's alternate address is stored against that contact", async () => {
  const f = seed();
  f.rows("contact_emails").push({ organization_id: ORG, contact_id: "k1", email: "pat.personal@gmail.com" });
  const r = await processGmailMessage(asClient(f), gmailMsg({ id: "g1", from: "Pat <Pat.Personal@gmail.com>", to: "me@b.com", rfc: "<alt@x>" }), ORG, U, { connectionId: "conn-b", email: "me@b.com" }, "push");
  assertEquals([r.processed, f.rows("messages")[0].contact_id, f.rows("mail_sender_suggestions").length], [true, "k1", 0]);
});

Deno.test("an unknown inbox sender named like one contact is suggested, only from the live feed and only from the inbox proper", async () => {
  const from = "Pat Avery <pat.personal@gmail.com>";
  const run = async (source: string, labels?: string[]) => {
    const f = new FakeSupabase({ contacts: [{ id: "k1", organization_id: ORG, email: "pat@acme.com", status: "active", first_name: "Pat", last_name: "Avery" }] });
    const r = await processGmailMessage(asClient(f), gmailMsg({ id: "g1", from, to: "me@b.com", rfc: "<u@x>", labels }), ORG, U, { connectionId: "conn-b", email: "me@b.com" }, source);
    assertEquals([r.processed, f.rows("messages").length], [false, 0]); // never stored on a name alone
    return f.rows("mail_sender_suggestions");
  };
  const made = await run("push");
  assertEquals([made.length, made[0].email, made[0].contact_id, made[0].mailbox_email], [1, "pat.personal@gmail.com", "k1", "me@b.com"]);
  assertEquals((await run("incremental_poll")).length, 1);
  assertEquals((await run("contact_backfill")).length, 0);             // history replays never ask
  assertEquals((await run("push", ["INBOX", "CATEGORY_PROMOTIONS"])).length, 0);
  assertEquals((await run("push", ["SPAM"])).length, 0);
  assertEquals(isInboxMail(["INBOX", "UNREAD"]), true);
  assertEquals([isInboxMail(["SENT"]), isInboxMail(undefined), isInboxMail(["INBOX", "TRASH"])], [false, false, false]);
});
