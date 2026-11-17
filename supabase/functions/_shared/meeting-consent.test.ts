import { assertEquals } from "jsr:@std/assert@1";
import { CONSENT_BASES, parseConsent } from "./meeting-consent.ts";

Deno.test("every known basis parses; unknown, empty and non-string bases are refused", () => {
  for (const b of CONSENT_BASES) assertEquals(parseConsent(b.value)?.basis, b.value);
  assertEquals(parseConsent("yes"), null);
  assertEquals(parseConsent(""), null);
  assertEquals(parseConsent(undefined), null);
  assertEquals(parseConsent(true), null);
});

Deno.test("the note is trimmed, capped at 500, and null when blank", () => {
  assertEquals(parseConsent("announced", "  hello  ")?.note, "hello");
  assertEquals(parseConsent("announced", "x".repeat(900))?.note?.length, 500);
  assertEquals(parseConsent("announced", "   ")?.note, null);
  assertEquals(parseConsent("announced", 42)?.note, null);
});
