import { assertEquals } from "jsr:@std/assert@1";
import { makeBudget } from "./run-budget.ts";

Deno.test("budget counts down, gates units and clamps timeouts", () => {
  let t = 1000;
  const b = makeBudget(40_000, () => t);
  assertEquals([b.left(), b.canStart(12_000), b.timeout(25_000)], [40_000, true, 25_000]);
  t += 30_000;
  assertEquals([b.left(), b.canStart(12_000), b.timeout(25_000)], [10_000, false, 10_000]);
  t += 60_000;
  assertEquals([b.left(), b.canStart(), b.timeout(25_000)], [0, false, 1000]);
});
