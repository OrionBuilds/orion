import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { callWithKeyFallback } from "./key-fallback.ts";

Deno.test("a rejected key falls through to the next; the working key's result is returned", async () => {
  const tried: string[] = [];
  const out = await callWithKeyFallback(["platform", "stale"], (k) => {
    tried.push(k);
    return k === "platform" ? Promise.reject(new Error("Anthropic API error 401: invalid x-api-key")) : Promise.resolve("ok");
  });
  assertEquals(out, "ok");
  assertEquals(tried, ["platform", "stale"]);
});

Deno.test("a non-auth failure is thrown at once without trying the other key", async () => {
  const tried: string[] = [];
  await assertRejects(() => callWithKeyFallback(["a", "b"], (k) => { tried.push(k); return Promise.reject(new Error("Anthropic API error 529: overloaded")); }), Error, "529");
  assertEquals(tried, ["a"]);
});

Deno.test("blank and duplicate keys are skipped; no keys at all is an error; all-rejected rethrows the last", async () => {
  const tried: string[] = [];
  await assertRejects(() => callWithKeyFallback(["", null, "x", "x", " x "], (k) => { tried.push(k); return Promise.reject(new Error("401")); }), Error, "401");
  assertEquals(tried, ["x"]);
  await assertRejects(() => callWithKeyFallback([null, ""], () => Promise.resolve(1)), Error, "No API key");
});
