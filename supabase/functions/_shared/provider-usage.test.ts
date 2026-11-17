import { assertEquals } from "jsr:@std/assert";
import {
  parseAnthropicCost,
  parseAnthropicUsage,
  parseElevenLabsSubscription,
  parseOpenAICosts,
  parseOpenAIUsage,
  summarize,
} from "./provider-usage.ts";

Deno.test("parseAnthropicUsage sums tokens per model across buckets and pages", () => {
  const pages = [
    { data: [{ starting_at: "2026-10-01T00:00:00Z", results: [
      { model: "claude-sonnet-5", uncached_input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 1 } },
    ] }], has_more: true, next_page: "p2" },
    { data: [{ starting_at: "2026-10-02T00:00:00Z", results: [
      { model: "claude-sonnet-5", uncached_input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      { model: "claude-haiku-4-5", uncached_input_tokens: 7, output_tokens: 3 },
    ] }], has_more: false },
  ];
  assertEquals(parseAnthropicUsage(pages), [
    { model: "claude-sonnet-5", input_tokens: 101, output_tokens: 11, cache_read_tokens: 50, cache_write_tokens: 6, requests: 0 },
    { model: "claude-haiku-4-5", input_tokens: 7, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0, requests: 0 },
  ]);
});

Deno.test("parseAnthropicCost converts cents strings to dollars per day", () => {
  const pages = [{ data: [
    { starting_at: "2026-10-01T00:00:00Z", results: [{ amount: "125.5", currency: "USD" }, { amount: "74.5", currency: "USD" }] },
    { starting_at: "2026-10-02T00:00:00Z", results: [] },
  ] }];
  assertEquals(parseAnthropicCost(pages), [{ day: "2026-10-01", cost_usd: 2 }, { day: "2026-10-02", cost_usd: 0 }]);
});

Deno.test("parseOpenAICosts / parseOpenAIUsage read dollar amounts and cached tokens", () => {
  const t = Date.UTC(2026, 9, 3) / 1000;
  assertEquals(parseOpenAICosts([{ data: [{ start_time: t, results: [{ amount: { value: 0.25, currency: "usd" } }, { amount: { value: 0.5 } }] }] }]),
    [{ day: "2026-10-03", cost_usd: 0.75 }]);
  assertEquals(parseOpenAIUsage([{ data: [{ start_time: t, results: [{ model: "gpt-x", input_tokens: 100, input_cached_tokens: 40, output_tokens: 9, num_model_requests: 2 }] }] }]),
    [{ model: "gpt-x", input_tokens: 60, output_tokens: 9, cache_read_tokens: 40, cache_write_tokens: 0, requests: 2 }]);
});

Deno.test("summarize totals cost and tokens; null cost when no cost data", () => {
  const s = summarize("a", "b", [{ day: "2026-10-01", cost_usd: 1.5 }, { day: "2026-10-02", cost_usd: 0.25 }],
    [{ model: "m", input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1 }]);
  assertEquals(s.cost_usd, 1.75);
  assertEquals(s.input_tokens, 13);
  assertEquals(s.output_tokens, 5);
  assertEquals(summarize("a", "b", null, []).cost_usd, null);
});

Deno.test("parseElevenLabsSubscription", () => {
  assertEquals(parseElevenLabsSubscription({ tier: "creator", status: "active", character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1_800_000_000 }), {
    tier: "creator", status: "active", characters_used: 1200, character_limit: 100000, resets_at: new Date(1_800_000_000_000).toISOString(),
  });
});

