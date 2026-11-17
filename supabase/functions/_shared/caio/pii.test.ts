import { assertEquals } from "jsr:@std/assert@1";
import { describeFlags, hasSecret, looksSensitive, luhnValid, scanPii } from "./pii.ts";

const get = (text: string, type: string) => scanPii(text).find((f) => f.type === type)?.count ?? 0;

Deno.test("scanPii: SSN-like, 9-digit and 12-17 digit account-like are counted", () => {
  assertEquals(get("my ssn is 123-45-6789 ok", "ssn"), 1);
  assertEquals(get("routing 021000021 and acct 000123456789012", "account_number"), 2);
  assertEquals(get("acct 1234567890123456 end", "account_number"), 1);
});

Deno.test("scanPii: card-like needs a valid Luhn; spaced and dashed forms count; not double counted as account", () => {
  assertEquals(get("card 4111 1111 1111 1111", "card_number"), 1);
  assertEquals(get("card 5500-0055-5555-5559", "card_number"), 1);
  assertEquals(get("4111111111111111", "account_number"), 0);
  assertEquals(get("order 4111 1111 1111 1112", "card_number"), 0);
});

Deno.test("scanPii: secret-like content", () => {
  assertEquals(get("password: hunter2hunter2hunter2", "secret"), 1);
  assertEquals(get("key AKIAABCDEFGHIJKLMNOP", "secret"), 1);
  assertEquals(hasSecret("nothing to see"), false);
});

Deno.test("scanPii: ordinary numbers do not trip it (phones, years, money, decimals, 10-digit ids)", () => {
  assertEquals(scanPii("Call 555-867-5309 in 2026, we spend $12,500.00 on 1234567890 widgets, 3.14159265358"), []);
});

Deno.test("scanPii reports counts only, never the matched text", () => {
  const flags = scanPii("ssn 123-45-6789 and card 4111111111111111 and password: abcdefghijklmnop1");
  assertEquals(JSON.stringify(flags).includes("123-45"), false);
  assertEquals(JSON.stringify(flags).includes("4111"), false);
  assertEquals(JSON.stringify(flags).includes("abcdefgh"), false);
  assertEquals(describeFlags([{ type: "ssn", count: 2 }]), "2 SSN-like");
  assertEquals(looksSensitive("123-45-6789"), true);
  assertEquals(looksSensitive("about 40 staff"), false);
  assertEquals(luhnValid("4111111111111111"), true);
});
