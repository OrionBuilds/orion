import { assertEquals } from "jsr:@std/assert@1";
import { enrichCrmFromOutlook, fillBlanks, parseGraphContact } from "./ms-contacts.ts";

Deno.test("parse: lowercases/dedupes emails, prefers mobile phone", () => {
  const e = parseGraphContact({
    emailAddresses: [{ address: "A@x.com" }, { address: "a@x.com" }, { address: "" }],
    businessPhones: ["555-1"], mobilePhone: "555-2", companyName: " Acme ", jobTitle: "",
  });
  assertEquals(e, { emails: ["a@x.com"], phone: "555-2", company: "Acme", jobTitle: null });
});

Deno.test("fillBlanks never overwrites non-empty fields", () => {
  const e = { emails: [], phone: "555", company: "Acme", jobTitle: "CEO" };
  assertEquals(fillBlanks({ id: "1", email: "a@x.com", phone: null, company: "", job_title: "CTO" }, e), { phone: "555", company: "Acme" });
  assertEquals(fillBlanks({ id: "1", email: "a@x.com", phone: "1", company: "C", job_title: "T" }, e), {});
});

Deno.test("only existing CRM contacts are updated; none are created", async () => {
  const ops: string[] = [];
  const crm = [
    { id: "c1", email: "Known@x.com", phone: null, company: null, job_title: null },
    { id: "c2", email: "full@x.com", phone: "1", company: "C", job_title: "T" },
  ];
  const db = {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const k of ["select", "eq", "not", "order"]) c[k] = () => c;
      c.range = () => Promise.resolve({ data: crm, error: null });
      c.update = (p: unknown) => { ops.push(`update:${JSON.stringify(p).includes("phone")}`); return { eq: () => Promise.resolve({ error: null }) }; };
      c.insert = () => { ops.push("INSERT"); return Promise.resolve({ error: null }); };
      return c;
    },
  };
  const page = { value: [
    { emailAddresses: [{ address: "known@x.com" }], mobilePhone: "555", companyName: "Acme" },
    { emailAddresses: [{ address: "full@x.com" }], mobilePhone: "999" },
    { emailAddresses: [{ address: "stranger@x.com" }], mobilePhone: "000" },
  ] };
  const f = (() => Promise.resolve(new Response(JSON.stringify(page)))) as unknown as typeof fetch;
  const r = await enrichCrmFromOutlook(db as never, "t", { orgId: "o" }, { fetchImpl: f });
  assertEquals(r, { scanned: 3, matched: 2, updated: 1 });
  assertEquals(ops, ["update:true"]);
});
