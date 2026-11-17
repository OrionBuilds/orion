import { assertEquals } from "jsr:@std/assert@1";
import { buildPushPayload, safeUrl, type NotificationRow } from "./push.ts";

const row = (o: Partial<NotificationRow>): NotificationRow => ({ id: "n1", user_id: "u", type: "message", title: "New SMS Received", body: "+1555: hi", link: "/conversations/c1", metadata: { conversation_id: "c1" }, ...o });

Deno.test("messages replace each other per conversation", () => {
  const p = buildPushPayload(row({}));
  assertEquals(p.tag, "conv-c1");
  assertEquals(p.url, "/conversations/c1");
  assertEquals(p.urgent, false);
});

Deno.test("a burst of approvals collapses into one rolling notification", () => {
  const p = buildPushPayload(row({ type: "agent_approval", title: "Approval needed", body: "harvey email" }), 7);
  assertEquals(p.body, "7 agent actions are waiting for you");
  assertEquals(p.tag, "approvals");
  assertEquals(p.url, "/automation/approvals");
  assertEquals(buildPushPayload(row({ type: "agent_approval", body: "harvey email to Warren" }), 1).body, "harvey email to Warren");
});

Deno.test("agent and Clara notifications are urgent; click targets stay inside the app", () => {
  assertEquals(buildPushPayload(row({ type: "agent_request", title: "Friday needs your answer" })).urgent, true);
  assertEquals(buildPushPayload(row({ type: "clara" })).urgent, true);
  assertEquals(safeUrl("https://evil.example/x"), "/");
  assertEquals(safeUrl("//evil.example"), "/");
  assertEquals(safeUrl(null), "/");
  assertEquals(safeUrl("/harvey"), "/harvey");
});

Deno.test("long text is trimmed and whitespace collapsed", () => {
  const p = buildPushPayload(row({ body: "a\n\n  b " + "x".repeat(400) }));
  assertEquals(p.body.length <= 160, true);
  assertEquals(p.body.startsWith("a b"), true);
});
