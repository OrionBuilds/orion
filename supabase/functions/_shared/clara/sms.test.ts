import { assertEquals } from "jsr:@std/assert@1";
import { audienceFor, escalationText, finalReply, holdingLine, mustEscalate, smsSystemPrompt } from "./sms.ts";

const env = (m: Record<string, string> = {}) => ({ get: (k: string) => m[k] });

Deno.test("money, contract and scope words always escalate, whatever the model said", () => {
  for (const t of ["how much is it", "can you send an invoice", "I want to sign the contract", "add another feature?", "what's your pricing"]) assertEquals(mustEscalate(t), true, t);
  for (const t of ["are you open tomorrow", "thanks!", "can we talk Thursday"]) assertEquals(mustEscalate(t), false, t);
});

Deno.test("an escalated or empty reply becomes the named holding line, never the model's text", () => {
  const model = { reply: "Sure, it's $5,000.", escalate: false };
  assertEquals(finalReply(model, "how much does it cost", "Jordan").text, holdingLine("Jordan")); // inbound guardrail beats a model that didn't flag it
  assertEquals(finalReply({ reply: "", escalate: false }, "hello", "Jordan").askOwner, true);
  assertEquals(finalReply({ reply: "We're open 9-5.", escalate: false }, "hours?", "Jordan"), { text: "We're open 9-5.", escalated: false, askOwner: false });
  assertEquals(finalReply({ reply: "x".repeat(500) }, "hi", "Jordan").text.length, 320);
  assertEquals(holdingLine("Jordan").includes("Clara"), true);
});

Deno.test("audience follows the number texted; prompts never leak private detail", () => {
  const e = env({ CLARA_WORKLINE_NUMBER: "+18135550199", OWNER_NAME: "Jordan Example" });
  assertEquals(audienceFor(e, "(813) 555-0199"), "workline");
  assertEquals(audienceFor(e, "+18135550142"), "business");
  for (const aud of ["workline", "business"] as const) {
    const p = smsSystemPrompt(e, { audience: aud, contactName: "Ann", company: "Acme", knowledge: "We build automations." });
    assertEquals(/gmail|127\.0\.0\.1|wife/i.test(p), false);
    assertEquals(p.includes("The sender is Ann at Acme."), true);
    assertEquals(p.includes("We build automations."), true);
  }
  assertEquals(smsSystemPrompt(e, { audience: "workline" }).includes("Never agree to, quote"), true);
  assertEquals(smsSystemPrompt(e, { audience: "business" }).includes("Never agree to, quote"), false);
});

Deno.test("owner escalation text says who, what, and the number to answer on", () => {
  const t = escalationText("Ann (Acme)", "+15551230000", "how much for the build", true);
  assertEquals(t.includes("money, contract or scope") && t.includes("+15551230000"), true);
});
