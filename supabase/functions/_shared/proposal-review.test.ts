import { assertEquals } from "jsr:@std/assert@1";
import { checkTableArithmetic, flagKey, parseMoney, reviewProposalSections, unacknowledgedFlags } from "./proposal-review.ts";

const table = (rows: string[][]) =>
  `<table>${rows.map((r, i) => `<tr>${r.map((c) => `<${i === 0 ? "th" : "td"}>${c}</${i === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}</table>`;

Deno.test("parseMoney reads plain money and refuses ranges, percentages and prose", () => {
  assertEquals(parseMoney("$1,250.50"), 1250.5);
  assertEquals(parseMoney("USD 3000"), 3000);
  assertEquals(parseMoney("AU$ 99"), 99);
  assertEquals(parseMoney("$1,000 – $2,000"), null);
  assertEquals(parseMoney("15%"), null);
  assertEquals(parseMoney("TBC"), null);
});

Deno.test("ISO-code currencies the generator reads (JPY, SGD, HKD, INR) are recognized as pricing tables", () => {
  assertEquals(parseMoney("JPY 100"), 100);
  assertEquals(parseMoney("SGD 2,000"), 2000);
  for (const code of ["JPY", "SGD", "HKD", "INR"]) {
    const bad = table([["Item", "Price"], ["Setup", `${code} 2,500`], ["Retainer", `${code} 1,500`], ["Total", `${code} 4,500`]]);
    const f = reviewProposalSections([{ title: "Pricing", content: bad }]);
    assertEquals(f.length, 1, `${code} mismatch should be flagged`);
    assertEquals(f[0].kind, "arithmetic");
  }
});

Deno.test("an ISO code glued to its amount (JPY400, no space) is still a money table, so a mismatch is caught", () => {
  const bad = table([["Item", "Price"], ["Setup", "JPY100"], ["Retainer", "JPY200"], ["Total", "JPY400"]]);
  const f = reviewProposalSections([{ title: "Pricing", content: bad }]);
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "arithmetic");
});

Deno.test("a mixed-currency table is never summed: USD and JPY lines do not produce a false arithmetic flag", () => {
  const mixed = table([["Region", "Price"], ["US", "USD 100"], ["Japan", "JPY 150"], ["Total (US only)", "USD 100"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: mixed }]), []);
});

Deno.test("markers: NEEDS PRICING, CONFIRM SCOPE and placeholders are flagged with their section", () => {
  const flags = reviewProposalSections([
    { title: "Pricing", content: "<p>Setup: NEEDS PRICING</p><p>Retainer [TBD]</p>" },
    { title: "Scope", content: "<p>CONFIRM SCOPE: includes migration?</p>" },
    { title: "Intro", content: "<p>All good.</p>" },
  ]);
  assertEquals(flags.map((f) => `${f.section}:${f.kind}`).sort(), ["Pricing:needs_pricing", "Pricing:placeholder", "Scope:confirm_scope"]);
});

Deno.test("a total that matches its lines is clean; one that does not is flagged with both numbers", () => {
  const ok = table([["Item", "Price"], ["Setup", "$2,500"], ["Retainer", "$1,500"], ["Total", "$4,000"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: ok }]), []);
  const bad = table([["Item", "Price"], ["Setup", "$2,500"], ["Retainer", "$1,500"], ["Total", "$4,500"]]);
  const f = reviewProposalSections([{ title: "Pricing", content: bad }]);
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "arithmetic");
  assertEquals(f[0].detail.includes("4000.00") && f[0].detail.includes("4500"), true);
});

Deno.test("qty x unit price lines are checked row by row", () => {
  const rows = [["Item", "Qty", "Unit price", "Total"], ["Workshop", "2", "$1,000", "$2,000"], ["Audit", "3", "$500", "$1,000"], ["Total", "", "", "$3,000"]];
  const f = checkTableArithmetic(rows.map((r) => r), "Pricing");
  assertEquals(f.length, 1);
  assertEquals(f[0].detail.includes("Audit"), true);
});

Deno.test("tables with discounts, tax or subtotals, ranges, or no total row are not judged", () => {
  const withDiscount = table([["Item", "Price"], ["Setup", "$2,500"], ["Retainer", "$1,500"], ["Discount", "-$500"], ["Total", "$3,500"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: withDiscount }]), []);
  const range = table([["Item", "Price"], ["Setup", "$2,000 – $3,000"], ["Retainer", "$1,500"], ["Total", "$4,000"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: range }]), []);
  const noTotal = table([["Item", "Price"], ["Setup", "$2,500"], ["Retainer", "$1,500"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: noTotal }]), []);
});

Deno.test("plain prose proposals with no markers are clean", () => {
  assertEquals(reviewProposalSections([{ title: "Intro", content: "<p>We will deliver the assessment in two weeks for a fixed fee.</p>" }]), []);
});

Deno.test("service names that merely start like an adjustment are line items: a wrong total is still flagged", () => {
  const t = table([["Item", "Price"], ["Tax preparation", "$1,000"], ["Paid media management", "$2,000"], ["Total", "$4,000"]]);
  const f = reviewProposalSections([{ title: "P", content: t }]);
  assertEquals(f.length, 1);
  assertEquals(f[0].kind, "arithmetic");
});

Deno.test("suffixed, hyphenated and ranged cells are not plain money, so such tables are not judged", () => {
  assertEquals(parseMoney("$500/month"), null);
  assertEquals(parseMoney("$2,000 one-time"), null);
  assertEquals(parseMoney("$2,000-$3,000"), null);
  const recurring = table([["Item", "Price"], ["Setup", "$2,000 one-time"], ["Retainer", "$500/month"], ["Total", "$8,000"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: recurring }]), []);
});

Deno.test("an unparseable line anywhere stops both arithmetic checks, even with a wrong total", () => {
  const t = table([["Item", "Qty", "Unit price", "Total"], ["Workshop", "2", "$1,000", "$9,999"], ["Audit", "1", "TBC", "TBC"], ["Total", "", "", "$100"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: t }]), []);
});

Deno.test("tolerance is rounding only: a $50 gap on a $1,000,000 total is flagged", () => {
  const t = table([["Item", "Price"], ["A", "$600,000"], ["B", "$399,950"], ["Total", "$1,000,000"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: t }]).length, 1);
});

Deno.test("a non-money table (no currency) is not a pricing table, so its numbers are never summed", () => {
  // A timeline: 2- and 4-week phases with a "Total project" of 4 weeks. 2 + 4 = 6 would look like a bad sum,
  // but the table carries no currency, so it is not judged as a pricing table.
  const timeline = table([["Phase", "Weeks"], ["Design", "2"], ["Build", "4"], ["Total project", "4"]]);
  assertEquals(reviewProposalSections([{ title: "Timeline", content: timeline }]), []);
});

Deno.test("a quantity mismatch is not flagged when the table has no total row", () => {
  const noTotal = table([["Item", "Qty", "Unit price", "Total"], ["Workshop", "2", "$1,000", "$5,000"], ["Audit", "3", "$500", "$1,500"]]);
  assertEquals(reviewProposalSections([{ title: "P", content: noTotal }]), []);
});

Deno.test("an acknowledgment covers exactly the flags that were seen", () => {
  const seen = reviewProposalSections([{ title: "P", content: "<p>NEEDS PRICING</p>" }]);
  const keys = seen.map(flagKey);
  assertEquals(unacknowledgedFlags(seen, keys), []);
  const later = reviewProposalSections([{ title: "P", content: "<p>NEEDS PRICING</p><p>CONFIRM SCOPE</p>" }]);
  assertEquals(unacknowledgedFlags(later, keys).map((f) => f.kind), ["confirm_scope"]);
  assertEquals(unacknowledgedFlags(later, undefined).length, 2);
});

Deno.test("a code-qualified dollar amount (CAD $100) is one currency, so a wrong total is still flagged", () => {
  const bad = table([["Item", "Price"], ["Setup", "CAD $100"], ["Retainer", "CAD $200"], ["Total", "CAD $400"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: bad }]).map((f) => f.kind), ["arithmetic"]);
});

Deno.test("a currency code in a line description is not a currency: a USD table named 'JPY migration' is still checked", () => {
  const bad = table([["Item", "Price"], ["JPY migration", "$100"], ["Support", "$200"], ["Total", "$400"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: bad }]).map((f) => f.kind), ["arithmetic"]);
});

Deno.test("a price header naming the currency makes the table a pricing table", () => {
  const bad = table([["Item", "Amount (USD)"], ["Setup", "100"], ["Retainer", "200"], ["Total", "400"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: bad }]).map((f) => f.kind), ["arithmetic"]);
});

Deno.test("a header currency qualifies bare-dollar cells in its column, so 'Amount (CAD)' with $ values is one currency", () => {
  const bad = table([["Item", "Amount (CAD)"], ["Setup", "$100"], ["Retainer", "$200"], ["Total", "$400"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: bad }]).map((f) => f.kind), ["arithmetic"]);
  const ok = table([["Item", "Amount (CAD)"], ["Setup", "$100"], ["Retainer", "$200"], ["Total", "$300"]]);
  assertEquals(reviewProposalSections([{ title: "Pricing", content: ok }]), []);
});

Deno.test("a different marker in the same section is a different flag, even when the count is unchanged", () => {
  const a = reviewProposalSections([{ title: "Scope", content: "<p>Integration work. CONFIRM SCOPE of the CRM sync.</p>" }]);
  const b = reviewProposalSections([{ title: "Scope", content: "<p>Training plan. CONFIRM SCOPE of the onboarding days.</p>" }]);
  assertEquals(a[0].detail, b[0].detail);
  assertEquals(flagKey(a[0]) === flagKey(b[0]), false);
  assertEquals(unacknowledgedFlags(b, a.map(flagKey)).length, 1);
  assertEquals(unacknowledgedFlags(a, a.map(flagKey)).length, 0);
});
