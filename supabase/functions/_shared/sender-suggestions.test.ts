import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { senderNameParts, suggestSenderAlias, type UnknownSender } from "./sender-suggestions.ts";

Deno.test("senderNameParts: plain person names only", () => {
  assertEquals(senderNameParts("Casey Sample"), { first: "Casey", last: "Sample" });
  assertEquals(senderNameParts('"Sample, Casey"'), { first: "Casey", last: "Sample" });
  assertEquals(senderNameParts("Mary-Jane van O'Neil"), { first: "Mary-Jane", last: "O'Neil" });
  for (const bad of ["", "Casey", "caseysample@gmail.com", "Google Cloud 100% Team", "J N", "Sales_Team Acme", "a b c d e", "Team (Billing) Acme"]) {
    assertEquals(senderNameParts(bad), null, bad);
  }
  assertEquals(senderNameParts("x@y.com", "x@y.com"), null);
});

const seed = (contacts: Record<string, unknown>[], suggestions: Record<string, unknown>[] = []) => new FakeSupabase({ contacts, mail_sender_suggestions: suggestions });
const CASEY = { id: "k1", organization_id: "o", email: "info@initechbox.com", status: "active", first_name: "Casey", last_name: "Sample" };
const mail = (over: Partial<UnknownSender> = {}): UnknownSender => ({
  orgId: "o", email: "CaseySample@gmail.com", name: "casey sample", subject: "circling back", mailboxEmail: "jordan@example.org", sentAt: "2026-11-11T17:08:00Z", ...over,
});

Deno.test("an unknown address whose display name is exactly one active contact becomes a pending suggestion", async () => {
  const f = seed([CASEY, { ...CASEY, id: "k9", organization_id: "other" }]);
  assertEquals(await suggestSenderAlias(asClient(f), mail()), "created");
  const s = f.rows("mail_sender_suggestions")[0];
  assertEquals([s.email, s.contact_id, s.mailbox_email, s.last_subject], ["caseysample@gmail.com", "k1", "jordan@example.org", "circling back"]);
  assertEquals(f.rows("contact_emails").length, 0); // nothing is linked until a person confirms
});

Deno.test("no suggestion for robots, colleagues, non-names, nobody, or a name two contacts share", async () => {
  const none = async (contacts: Record<string, unknown>[], over: Partial<UnknownSender>) => {
    const f = seed(contacts);
    assertEquals(await suggestSenderAlias(asClient(f), mail(over)), "none");
    assertEquals(f.rows("mail_sender_suggestions").length, 0);
  };
  await none([CASEY], { email: "no-reply@initechbox.com" });
  await none([CASEY], { email: "casey@example.org" });            // same domain as the mailbox
  await none([CASEY], { email: "jordan@example.org" });
  await none([CASEY], { name: "Initech Box" });                           // no such person
  await none([CASEY], { name: "caseysample@gmail.com" });
  await none([CASEY], { subject: "Invitation: sync @ Thu" });
  await none([CASEY, { ...CASEY, id: "k2", email: "other@x.com" }], {}); // ambiguous
  await none([{ ...CASEY, status: "archived" }], {});
});

Deno.test("two free-mail addresses are not colleagues", async () => {
  const f = seed([CASEY]);
  assertEquals(await suggestSenderAlias(asClient(f), mail({ mailboxEmail: "owner@gmail.com" })), "created");
});

Deno.test("a pending suggestion is refreshed, an answered one is never asked again", async () => {
  const f = seed([CASEY]);
  const db = asClient(f);
  await suggestSenderAlias(db, mail());
  assertEquals(await suggestSenderAlias(db, mail({ subject: "one more thing", sentAt: "2026-11-11T21:35:00Z" })), "updated");
  const s = f.rows("mail_sender_suggestions");
  assertEquals([s.length, s[0].message_count, s[0].last_subject, s[0].last_seen_at], [1, 2, "one more thing", "2026-11-11T21:35:00Z"]);

  s[0].status = "ignored";
  assertEquals(await suggestSenderAlias(db, mail()), "none");
  assertEquals(f.rows("mail_sender_suggestions").length, 1);
});

Deno.test("a database failure never reaches the mail sync", async () => {
  const broken = { from: () => { throw new Error("db down"); } } as never;
  assertEquals(await suggestSenderAlias(broken, mail()), "none");
});
