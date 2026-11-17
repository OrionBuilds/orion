import { assertEquals } from "jsr:@std/assert@1";
import { isOwner, normalizeE164, ownerDeliveryNumber, samePhone, transferTarget } from "./phones.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

Deno.test("normalizeE164 handles US forms and rejects junk", () => {
  assertEquals(normalizeE164("(813) 555-0100"), "+18135550100");
  assertEquals(normalizeE164("1 813 555 0100"), "+18135550100");
  assertEquals(normalizeE164("+354 123 4567"), "+3541234567"); // non-NANP: 8-15 digits is valid
  assertEquals(normalizeE164("+1 813 555"), null);            // NANP must be exactly 11 digits
  assertEquals(normalizeE164("call me"), null);
});

Deno.test("identity needs the full number, not a suffix", () => {
  assertEquals(samePhone("+18135550100", "813-555-0100"), true);
  assertEquals(samePhone("+448135550100", "+18135550100"), false);
  assertEquals(samePhone("abc", "abc"), false);
});

Deno.test("owner is recognised on work and personal numbers", () => {
  const e = env({ OWNER_WORK_PHONE: "+18135550001", OWNER_PERSONAL_PHONE: "+18135550002" });
  assertEquals(isOwner(e, "813-555-0001"), true);
  assertEquals(isOwner(e, "+18135550009"), false);
});

Deno.test("delivery/transfer never use a loop number", () => {
  const e = env({ OWNER_PHONE: "+18135550001", OWNER_WORK_PHONE: "+18135550001", CLARA_TWILIO_NUMBER: "+18135550142" });
  assertEquals(ownerDeliveryNumber(e), undefined);     // only the work phone is configured
  assertEquals(transferTarget(e), undefined);
  const e2 = env({ ...{ OWNER_WORK_PHONE: "+18135550001" }, OWNER_PERSONAL_PHONE: "+18135550002" });
  assertEquals(ownerDeliveryNumber(e2), "+18135550002");
  assertEquals(transferTarget(e2), "+18135550002");
  assertEquals(transferTarget(env({ OWNER_PERSONAL_PHONE: "+18135550142", CLARA_TWILIO_NUMBER: "+18135550142" })), undefined);
});
