import { assertEquals } from "jsr:@std/assert@1";
import { brandIdentity, parseBrands } from "./brands.ts";

const org = {
  name: "Acme Holdings LLC",
  display_name: "Acme Co",
  legal_name: "Acme Holdings LLC DBA: Acme Co",
  email: "hello@acme.example.com",
  phone: "555",
  website: "https://acme.example.com",
};

const brands = parseBrands(JSON.stringify([
  { key: "default", label: "Acme Co" },
  { key: "studio", label: "Jordan Studio", siteUrl: "https://studio.example.com", legalName: "Jordan Example LLC" },
]));

Deno.test("parseBrands falls back to one default brand and drops invalid entries", () => {
  assertEquals(parseBrands(undefined), [{ key: "default", label: "My Business" }]);
  assertEquals(parseBrands("not json"), [{ key: "default", label: "My Business" }]);
  assertEquals(parseBrands("[]"), [{ key: "default", label: "My Business" }]);
  assertEquals(parseBrands('[{"key":"a"},{"label":"no key"},{"key":"a","label":"dup"}]'), [{ key: "a", label: "a" }]);
  assertEquals(brands.map((b) => b.key), ["default", "studio"]);
});

Deno.test("a secondary brand's client documents are written as that brand", () => {
  const id = brandIdentity("studio", org, { email: "jordan@studio.example.com" }, brands);
  assertEquals(id.name, "Jordan Example LLC");
  assertEquals(id.legal_name, "Jordan Example LLC");
  assertEquals(id.email, "jordan@studio.example.com");
  assertEquals(id.website, "https://studio.example.com");
});

Deno.test("a secondary brand falls back to the org email when the brand has no sender", () => {
  assertEquals(brandIdentity("studio", org, null, brands).email, "hello@acme.example.com");
});

Deno.test("the default brand keeps the org display identity", () => {
  const id = brandIdentity("default", org, null, brands);
  assertEquals(id.name, "Acme Co");
  assertEquals(id.legal_name, "Acme Holdings LLC DBA: Acme Co");
  assertEquals(id.website, "https://acme.example.com");
});
