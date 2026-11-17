import { assertEquals } from "jsr:@std/assert@1";
import { failureNotification, shouldSuppress, tagValue } from "./resend-events.ts";

Deno.test("only permanent bounces and complaints suppress; 5.7.x and transient bounces never do", () => {
  assertEquals(shouldSuppress("email.complained", {}), true);
  assertEquals(shouldSuppress("email.bounced", { bounce: { type: "Permanent", message: "550 5.1.1 user unknown" } }), true);
  assertEquals(shouldSuppress("email.bounced", { bounce: { type: "Permanent", message: "550 5.7.708 traffic not accepted" } }), false);
  assertEquals(shouldSuppress("email.bounced", { bounce: { type: "Transient" } }), false);
  assertEquals(shouldSuppress("email.bounced", {}), true);
  assertEquals(shouldSuppress("email.delivered", {}), false);
});

Deno.test("tags are read from both Resend shapes", () => {
  assertEquals(tagValue({ tags: { orion_user: "u1" } }, "orion_user"), "u1");
  assertEquals(tagValue({ tags: [{ name: "orion_user", value: "u2" }] }, "orion_user"), "u2");
  assertEquals(tagValue({}, "orion_user"), null);
});

Deno.test("bounce and complaint notify; other events do not", () => {
  const n = failureNotification("email.bounced", { email_id: "e1", to: ["pat@x.com"], bounce: { type: "Permanent", subType: "General", message: "mailbox full" } }, "u1")!;
  assertEquals(n.user_id, "u1");
  assertEquals(n.type, "email_delivery_failed");
  assertEquals(n.metadata.external_id, "e1");
  assertEquals(n.body.includes("pat@x.com"), true);
  assertEquals(failureNotification("email.complained", { to: "pat@x.com", subject: "Hi" }, "u1")!.title, "A recipient marked your email as spam");
  assertEquals(failureNotification("email.delivered", {}, "u1"), null);
});
