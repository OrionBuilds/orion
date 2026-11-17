import { assertEquals } from "jsr:@std/assert@1";
import { validateSamKey } from "./sam-key.ts";

const status = (n: number): typeof fetch => () => Promise.resolve(new Response("{}", { status: n }));

Deno.test("key validation: 200/404/429 are valid, 401/403 rejected, anything else reported", async () => {
  assertEquals((await validateSamKey("k", status(200))).ok, true);
  assertEquals((await validateSamKey("k", status(404))).ok, true);
  assertEquals((await validateSamKey("k", status(429))).ok, true);
  const bad = await validateSamKey("k", status(403));
  assertEquals(bad.ok, false);
  assertEquals((await validateSamKey("k", status(500)) as { error: string }).error, "SAM.gov returned 500");
});

Deno.test("key validation never puts the key in an error", async () => {
  const r = await validateSamKey("SECRETKEY", status(401)) as { error: string };
  assertEquals(r.error.includes("SECRETKEY"), false);
});
