import { assertEquals } from "jsr:@std/assert@1";
import { reminderSkipReason } from "./guards.ts";

Deno.test("paid, void and missing invoices are never chased", () => {
  assertEquals(reminderSkipReason({ status: "paid" }), "paid_or_void");
  assertEquals(reminderSkipReason({ status: "void" }), "paid_or_void");
  assertEquals(reminderSkipReason(null), "missing");
});

Deno.test("a disputed invoice is held even when it is overdue", () => {
  assertEquals(reminderSkipReason({ status: "overdue", disputed_at: "2026-11-01T10:00:00Z" }), "disputed");
  assertEquals(reminderSkipReason({ status: "sent", disputed_at: "2026-11-01T10:00:00Z" }), "disputed");
});

Deno.test("an ordinary open invoice may be chased", () => {
  assertEquals(reminderSkipReason({ status: "overdue", disputed_at: null }), null);
  assertEquals(reminderSkipReason({ status: "sent" }), null);
});
