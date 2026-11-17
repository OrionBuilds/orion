import { assertEquals } from "jsr:@std/assert@1";
import { parseUuid, shapeCaioDocument, shapeCaioPortal } from "./caio-portal.ts";

Deno.test("parseUuid accepts uuids and rejects everything else", () => {
  assertEquals(parseUuid("123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
  for (const bad of ["", "abc", "1; drop table", null, undefined, 5, {}, "123e4567-e89b-12d3-a456-42661417400"]) {
    assertEquals(parseUuid(bad), null);
  }
});

Deno.test("shapeCaioPortal: NULL / non-object means portal disabled", () => {
  assertEquals(shapeCaioPortal(null), { enabled: false });
  assertEquals(shapeCaioPortal(undefined), { enabled: false });
  assertEquals(shapeCaioPortal([]), { enabled: false });
  assertEquals(shapeCaioPortal("x"), { enabled: false });
});

Deno.test("shapeCaioPortal: passes payload through with enabled:true", () => {
  const out = shapeCaioPortal({ engagement: { code: "C1" }, gates: [], documents: [], registers: [] });
  assertEquals(out.enabled, true);
  assertEquals(out.engagement, { code: "C1" });
});

Deno.test("shapeCaioDocument: null -> null (404), object passes through", () => {
  assertEquals(shapeCaioDocument(null), null);
  assertEquals(shapeCaioDocument([1]), null);
  assertEquals(shapeCaioDocument({ id: "d", body_html: "<p>x</p>" }), { id: "d", body_html: "<p>x</p>" });
});
