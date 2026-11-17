import { assertEquals } from "jsr:@std/assert@1";
import {
  connectedProviders,
  getProviderAccountEmail,
  getUserProviders,
  normalizeAccountProvider,
  pickOrgDefault,
  pickProvider,
  resolveOrgDefaultProvider,
  resolveUserProvider,
} from "./provider.ts";
import { FakeSupabase } from "./testing/fake-supabase.ts";

Deno.test("normalises connected-account provider values", () => {
  assertEquals(normalizeAccountProvider("google_workspace"), "google");
  assertEquals(normalizeAccountProvider("google_gmail"), "google");
  assertEquals(normalizeAccountProvider("microsoft_365"), "microsoft");
  assertEquals(normalizeAccountProvider("twilio"), null);
  assertEquals(normalizeAccountProvider(null), null);
});

Deno.test("connectedProviders ignores disconnected rows and dedupes", () => {
  assertEquals(connectedProviders([
    { provider: "google_gmail", status: "connected" },
    { provider: "google_workspace", status: "connected" },
    { provider: "microsoft_365", status: "error" },
  ]), ["google"]);
  assertEquals(connectedProviders([{ provider: "google_workspace" }, { provider: "microsoft_365" }]), ["microsoft", "google"]);
});

Deno.test("pickProvider: prefer > org default > first connected", () => {
  assertEquals(pickProvider([]), null);
  assertEquals(pickProvider(["google"]), "google");
  assertEquals(pickProvider(["microsoft", "google"]), "microsoft");
  assertEquals(pickProvider(["microsoft", "google"], { orgDefault: "google" }), "google");
  assertEquals(pickProvider(["microsoft", "google"], { prefer: "google", orgDefault: "microsoft" }), "google");
  assertEquals(pickProvider(["microsoft"], { prefer: "google" }), "microsoft");
});

Deno.test("pickOrgDefault: explicit setting, else majority, Microsoft wins ties", () => {
  assertEquals(pickOrgDefault("google", [["microsoft"]]), "google");
  assertEquals(pickOrgDefault(null, [["google"], ["google"], ["microsoft"]]), "google");
  assertEquals(pickOrgDefault(null, [["google"], ["microsoft"]]), "microsoft");
  assertEquals(pickOrgDefault("bogus", []), null);
});

const seed = () => new FakeSupabase({
  organizations: [
    { id: "orgMs", default_workspace_provider: null },
    { id: "orgG", default_workspace_provider: "google" },
  ],
  users: [
    { id: "uMs", organization_id: "orgMs" },
    { id: "uBoth", organization_id: "orgMs" },
    { id: "uG", organization_id: "orgG" },
    { id: "uNone", organization_id: "orgG" },
  ],
  user_connected_accounts: [
    { user_id: "uMs", provider: "microsoft_365", status: "connected", provider_account_email: "ms@x.com" },
    { user_id: "uBoth", provider: "microsoft_365", status: "connected", provider_account_email: "b@x.com" },
    { user_id: "uBoth", provider: "google_workspace", status: "connected", provider_account_email: "b@gmail.com" },
    { user_id: "uG", provider: "google_gmail", status: "connected", provider_account_email: "g@x.com" },
  ],
});

Deno.test("resolves user providers from user_connected_accounts", async () => {
  const db = seed();
  assertEquals(await getUserProviders(db, "uMs"), ["microsoft"]);
  assertEquals(await getUserProviders(db, "uG"), ["google"]);
  assertEquals(await getUserProviders(db, "uNone"), []);
  assertEquals(await resolveUserProvider(db, "uNone"), null);
  assertEquals(await resolveUserProvider(db, "uG", { orgId: "orgG" }), "google");
  // both connected -> org default (orgMs has no setting, majority Microsoft)
  assertEquals(await resolveUserProvider(db, "uBoth", { orgId: "orgMs" }), "microsoft");
  assertEquals(await resolveUserProvider(db, "uBoth", { prefer: "google" }), "google");
  assertEquals(await getProviderAccountEmail(db, "uBoth", "google"), "b@gmail.com");
  assertEquals(await getProviderAccountEmail(db, "uMs", "google"), null);
});

Deno.test("org default: setting wins, else majority of connected users", async () => {
  const db = seed();
  assertEquals(await resolveOrgDefaultProvider(db, "orgG"), "google");
  assertEquals(await resolveOrgDefaultProvider(db, "orgMs"), "microsoft");
  assertEquals(await resolveOrgDefaultProvider(db, "nope"), null);
});

Deno.test("getProviderAccountEmail(google) returns the PRIMARY account's email when several Google accounts exist", async () => {
  const db = new FakeSupabase({
    google_oauth_master: [
      { id: "m1", user_id: "uTwo", email: "second@gmail.com", is_primary: false },
      { id: "m2", user_id: "uTwo", email: "main@work.com", is_primary: true },
    ],
    user_connected_accounts: [
      { user_id: "uTwo", provider: "google_workspace", status: "connected", provider_account_email: "stale@old.com" },
    ],
  });
  assertEquals(await getProviderAccountEmail(db, "uTwo", "google"), "main@work.com");
  // no master row yet: falls back to the connected-accounts mirror, as before
  assertEquals(await getProviderAccountEmail(seed(), "uG", "google"), "g@x.com");
});
