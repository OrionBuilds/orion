import { assertEquals } from "jsr:@std/assert";
import { buildUsageRow, errorMessageFromBody, estimateCostUsd, meteredFetch, meteredProvider, usageFromAnthropicSse, usageFromJson } from "./ai-usage.ts";

Deno.test("meteredProvider picks out model calls only", () => {
  assertEquals(meteredProvider("https://api.anthropic.com/v1/messages"), "anthropic");
  assertEquals(meteredProvider("https://api.anthropic.com/v1/messages/count_tokens"), null);
  assertEquals(meteredProvider("https://api.anthropic.com/v1/models"), null);
  assertEquals(meteredProvider("https://api.openai.com/v1/chat/completions"), "openai");
  assertEquals(meteredProvider("https://api.openai.com/v1/responses"), "openai");
  assertEquals(meteredProvider("https://example.com/v1/messages"), null);
  assertEquals(meteredProvider("not a url"), null);
});

Deno.test("usageFromJson reads Anthropic usage including cache tokens", () => {
  const u = usageFromJson("anthropic", {
    model: "claude-sonnet-5",
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 },
  });
  assertEquals(u, { model: "claude-sonnet-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 800 });
  assertEquals(usageFromJson("anthropic", { error: { message: "x" } }), null);
});

Deno.test("usageFromJson splits OpenAI cached prompt tokens out of input", () => {
  const u = usageFromJson("openai", {
    model: "gpt-x",
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } },
  });
  assertEquals(u, { model: "gpt-x", inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 });
});

Deno.test("usageFromAnthropicSse combines message_start and the last message_delta", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":90,"output_tokens":1,"cache_read_input_tokens":10}}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":42}}',
    "",
  ].join("\n");
  assertEquals(usageFromAnthropicSse(sse), { model: "claude-haiku-4-5", inputTokens: 90, outputTokens: 42, cacheReadTokens: 10, cacheWriteTokens: 0 });
  assertEquals(usageFromAnthropicSse("data: not json\n"), null);
});

Deno.test("estimateCostUsd uses published prices and refuses to guess unknown models", () => {
  // Sonnet 5: $2 in / $10 out; cache read 10% of input; cache write 1.25x input.
  const c = estimateCostUsd({ model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
  assertEquals(c, 2 + 1 + 0.2);
  // Haiku 4.5: $1 / $5, longest prefix beats "claude-haiku-4" style collisions.
  assertEquals(estimateCostUsd({ model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }), 1 + 1.25);
  assertEquals(estimateCostUsd({ model: "mystery-model", inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
});

Deno.test("buildUsageRow marks estimated vs unknown cost and error status", () => {
  const ctx = { source: "clara-sms-responder", agent: "clara", runId: null, purpose: "sms reply" };
  const est = buildUsageRow(ctx, "org", "anthropic", { model: "claude-haiku-4-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, { ok: true, durationMs: 812.4 });
  assertEquals(est.cost_source, "estimated");
  assertEquals(est.cost_usd, 0.0015);
  assertEquals(est.status, "ok");
  assertEquals(est.duration_ms, 812);
  const unk = buildUsageRow(ctx, "org", "anthropic", { model: "weird", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { ok: false, durationMs: 5 });
  assertEquals(unk.cost_source, "unknown");
  assertEquals(unk.cost_usd, null);
  assertEquals(unk.status, "error");
  const rep = buildUsageRow(ctx, "org", "anthropic", { model: "weird", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reportedCostUsd: 0.42 }, { ok: true, durationMs: 1 });
  assertEquals(rep.cost_source, "reported");
  assertEquals(rep.cost_usd, 0.42);
});

Deno.test("meteredFetch is a pass-through without service credentials", async () => {
  const original = globalThis.fetch;
  const body = JSON.stringify({ model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } });
  globalThis.fetch = (() => Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;
  try {
    const res = await meteredFetch({ source: "test", agent: "clara" })("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
    assertEquals(await res.text(), body);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("errorMessageFromBody: provider message, status, no keys, bounded", () => {
  assertEquals(errorMessageFromBody(529, JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } })), "HTTP 529: Overloaded");
  assertEquals(errorMessageFromBody(500, "<html>boom</html>"), "HTTP 500: <html>boom</html>");
  assertEquals(errorMessageFromBody(502, ""), "HTTP 502");
  const leaked = errorMessageFromBody(401, JSON.stringify({ error: { message: "Invalid key sk-ant-api03-abcdefghijklmnop and Bearer abc.def" } }));
  assertEquals(leaked.includes("abcdefghijklmnop"), false);
  assertEquals(leaked.includes("abc.def"), false);
  assertEquals(errorMessageFromBody(500, "x".repeat(1000)).length <= 320, true);
});
