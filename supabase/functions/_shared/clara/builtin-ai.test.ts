import { assertEquals, assert } from "jsr:@std/assert@1";
import { builtinAiMeter, builtinAiName, normalizeName, withBuiltinAi } from "./builtin-ai.ts";

Deno.test("normalizeName: default, off, trimmed and bounded", () => {
  assertEquals(normalizeName(undefined), "Clara");
  assertEquals(normalizeName(null), "Clara");
  assertEquals(normalizeName("   "), null);
  assertEquals(normalizeName("  Ada\n Lovelace "), "Ada Lovelace");
  assertEquals(normalizeName("x".repeat(80))!.length, 40);
});

Deno.test("withBuiltinAi: persona first, task unchanged; off = untouched", () => {
  const out = withBuiltinAi("Clara", "TASK TEXT");
  assert(out.startsWith("You are Clara"));
  assert(out.endsWith("\n\nTASK TEXT"));
  assertEquals(withBuiltinAi(null, "TASK TEXT"), "TASK TEXT");
});

Deno.test("builtinAiMeter: clara when on, os when off, org kept", () => {
  assertEquals(builtinAiMeter("Clara", "ai-report-query", "o1"), { source: "ai-report-query", agent: "clara", orgId: "o1" });
  assertEquals(builtinAiMeter(null, "x"), { source: "x", agent: "os" });
});

Deno.test("builtinAiName: reads the org setting; any failure keeps the default", async () => {
  const mk = (res: unknown) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(res) }) }) }) });
  assertEquals(await builtinAiName(mk({ data: { builtin_ai_name: "Ada" } }), "o"), "Ada");
  assertEquals(await builtinAiName(mk({ data: { builtin_ai_name: "" } }), "o"), null);
  assertEquals(await builtinAiName(mk({ data: null, error: { message: "column does not exist" } }), "o"), "Clara");
  assertEquals(await builtinAiName({ from: () => { throw new Error("boom"); } }, "o"), "Clara");
  assertEquals(await builtinAiName(mk({}), undefined), "Clara");
});
