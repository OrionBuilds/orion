import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabase, asClient } from "./testing/fake-supabase.ts";
import { findContactByEmail } from "./contact-lookup.ts";

const seed = (extra: Record<string, Record<string, unknown>[]> = {}) => new FakeSupabase({
  contacts: [
    { id: "k1", organization_id: "o", email: "info@initechbox.com", status: "active", first_name: "Casey", last_name: "N", department_id: "d1" },
    { id: "k2", organization_id: "o", email: "old@gone.com", status: "archived", first_name: "Old", last_name: "Gone", department_id: null },
  ],
  contact_emails: [
    { organization_id: "o", contact_id: "k1", email: "casey.personal@gmail.com" },
    { organization_id: "o", contact_id: "k2", email: "old.personal@gmail.com" },
    { organization_id: "other", contact_id: "k1", email: "elsewhere@gmail.com" },
  ],
  ...extra,
});

Deno.test("a contact is found by its main address or any alternate one, case-insensitively", async () => {
  const db = asClient(seed());
  assertEquals((await findContactByEmail(db, "o", "Info@InitechBox.com"))?.id, "k1");
  const alt = await findContactByEmail(db, "o", " Casey.Personal@Gmail.com ");
  assertEquals([alt?.id, alt?.department_id, alt?.first_name], ["k1", "d1", "Casey"]);
});

Deno.test("an unknown address, another org's alternate, or an alternate of an archived contact is nobody", async () => {
  const db = asClient(seed());
  assertEquals(await findContactByEmail(db, "o", "stranger@gmail.com"), null);
  assertEquals(await findContactByEmail(db, "o", "elsewhere@gmail.com"), null);
  assertEquals(await findContactByEmail(db, "o", "old.personal@gmail.com"), null);
  assertEquals(await findContactByEmail(db, "o", "  "), null);
});
