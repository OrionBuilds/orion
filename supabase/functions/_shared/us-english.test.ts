import { assert, assertEquals } from "jsr:@std/assert@1";
import { US_SPELLING_RULE, withUsSpelling } from "./us-english.ts";

const body = (init?: RequestInit) => JSON.parse(String(init?.body));

Deno.test("an Anthropic string system prompt gets the US spelling rule once", () => {
  const once = withUsSpelling("anthropic", { method: "POST", body: JSON.stringify({ system: "You are Clara.", messages: [] }) });
  assertEquals(body(once).system, `You are Clara.\n\n${US_SPELLING_RULE}`);
  assertEquals(withUsSpelling("anthropic", once), once);
});

Deno.test("cached system blocks stay first and untouched; the rule is a trailing block", () => {
  const blocks = [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }];
  const out = body(withUsSpelling("anthropic", { body: JSON.stringify({ system: blocks, messages: [] }) }));
  assertEquals(out.system[0], blocks[0]);
  assertEquals(out.system[1], { type: "text", text: US_SPELLING_RULE });
});

Deno.test("no system prompt gets one; OpenAI chat gets a leading system message", () => {
  assertEquals(body(withUsSpelling("anthropic", { body: JSON.stringify({ messages: [] }) })).system, US_SPELLING_RULE);
  const oa = body(withUsSpelling("openai", { body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }));
  assertEquals(oa.messages[0], { role: "system", content: US_SPELLING_RULE });
  assertEquals(oa.messages.length, 2);
});

Deno.test("a body it can't read goes through unchanged", () => {
  const raw = { body: "not json" };
  assert(withUsSpelling("anthropic", raw) === raw);
  assertEquals(withUsSpelling("anthropic", undefined), undefined);
});
