import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "../testing/fake-supabase.ts";
import { triageMailbox } from "./runtime.ts";
import type { MailRef } from "./email-triage.ts";

const env = { get: (k: string) => ({ CLARA_USER_ID: "clara", OWNER_USER_ID: "owner", CLARA_CALENDAR_USER_ID: "owner" } as Record<string, string>)[k] };
const db = () => asClient(new FakeSupabase({
  microsoft_oauth_master: [
    { id: "ms-clara", organization_id: "o", user_id: "clara", email: "clara@x.com" },
    { id: "ms-owner", organization_id: "o", user_id: "owner", email: "s.richard@x.com" },
    { id: "ms-staff", organization_id: "o", user_id: "maria", email: "maria@x.com" },
    { id: "ms-else", organization_id: "other", user_id: "owner", email: "o@other.com" },
  ],
  google_oauth_master: [
    { id: "go-owner", org_id: "o", user_id: "owner", email: "Jordan@Lab.com" },
    { id: "go-staff", org_id: "o", user_id: "maria", email: "maria@lab.com" },
  ],
}));
const ref = (over: Partial<MailRef>): MailRef => ({ provider: "microsoft", connectionId: null, mailboxEmail: null, from: "pat@acme.com", subject: "s", ...over });

Deno.test("triage answers for Clara's and the owner's mailboxes, and for nobody else's", async () => {
  assertEquals(await triageMailbox(db(), env, "o", ref({ connectionId: "ms-clara" })), { provider: "microsoft", userId: "clara", connectionId: "ms-clara", own: true });
  assertEquals(await triageMailbox(db(), env, "o", ref({ connectionId: "ms-owner" })), { provider: "microsoft", userId: "owner", connectionId: "ms-owner", own: false });
  assertEquals(await triageMailbox(db(), env, "o", ref({})), { provider: "microsoft", userId: "clara", connectionId: null, own: true }); // rows from before mailboxes were tracked
  assertEquals(await triageMailbox(db(), env, "o", ref({ connectionId: "ms-staff" })), null);
  assertEquals(await triageMailbox(db(), env, "o", ref({ connectionId: "ms-else" })), null); // another organization's connection
  assertEquals(await triageMailbox(db(), env, "o", ref({ connectionId: "gone" })), null);

  assertEquals(await triageMailbox(db(), env, "o", ref({ provider: "google", connectionId: "go-owner" })), { provider: "google", userId: "owner", connectionId: "go-owner" });
  assertEquals(await triageMailbox(db(), env, "o", ref({ provider: "google", mailboxEmail: "jordan@lab.com" })), { provider: "google", userId: "owner", connectionId: "go-owner" });
  assertEquals(await triageMailbox(db(), env, "o", ref({ provider: "google", connectionId: "go-staff" })), null);
  assertEquals(await triageMailbox(db(), env, "o", ref({ provider: "google" })), null);
});
