import { assertEquals } from "jsr:@std/assert@1";
import { ndrNotification, parseNdr } from "./ms-ndr.ts";

const body708 = `Your message to jordan.example.llc@gmail.com couldn't be delivered.
Remote Server returned '550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP.'
Diagnostic information: jordan@example.org`;

Deno.test("5.7.708 NDR is a tenant block with the failed recipient", () => {
  const n = parseNdr({ fromEmail: "postmaster@exampleorg.onmicrosoft.com", subject: "Undeliverable: Hello", body: body708 }, "jordan@example.org")!;
  assertEquals(n.code, "5.7.708");
  assertEquals(n.tenantBlock, true);
  assertEquals(n.recipients, ["jordan.example.llc@gmail.com"]);
  assertEquals(n.reason.includes("5.7.708"), true);
});

Deno.test("bad-recipient NDR (5.1.1) is not a tenant block", () => {
  const n = parseNdr({ fromEmail: "postmaster@x.com", subject: "Undeliverable: Hi", body: "Your message to nobody@example.com couldn't be delivered.\n550 5.1.1 User unknown" })!;
  assertEquals(n.code, "5.1.1");
  assertEquals(n.tenantBlock, false);
});

Deno.test("ordinary mail and human 'Undeliverable' subjects are not NDRs", () => {
  assertEquals(parseNdr({ fromEmail: "client@example.com", subject: "Quote", body: "Hello" }), null);
  assertEquals(parseNdr({ fromEmail: "friend@example.com", subject: "Undeliverable?", body: "lol did my last note arrive" }), null);
});

Deno.test("notification wording differs for tenant blocks and carries the dedupe key", () => {
  const n = parseNdr({ fromEmail: "postmaster@x.com", subject: "Undeliverable", body: body708 }, "jordan@example.org")!;
  const note = ndrNotification(n, "u1", "ms:AAA=");
  assertEquals(note.title, "Microsoft is blocking your outgoing email");
  assertEquals(note.metadata.external_id, "ms:AAA=");
  assertEquals(note.user_id, "u1");
});
