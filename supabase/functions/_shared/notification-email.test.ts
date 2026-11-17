import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildNotificationEmail } from "./notification-email.ts";

Deno.test("renders heading, intro, rows, a button and the plain URL; escapes everything", () => {
  const m = buildNotificationEmail({
    subject: "Task assigned: Call <Acme>",
    heading: "Task assigned to you",
    intro: "Sarah & Co assigned you a task.",
    rows: [["Task", "Call <Acme>"], ["Due", ""], ["Description", "Line 1\nLine 2"]],
    cta: { label: "Open task", url: "https://os.example.com/calendars?tab=tasks&taskId=t1" },
  });
  assertEquals(m.subject, "Task assigned: Call <Acme>");
  assert(!m.html.includes("<Acme>"));
  assertStringIncludes(m.html, "Call &lt;Acme&gt;");
  assertStringIncludes(m.html, "Sarah &amp; Co");
  assertStringIncludes(m.html, "Line 1<br>Line 2");
  assert(!m.html.includes("Due"), "empty rows are dropped");
  assertStringIncludes(m.html, 'href="https://os.example.com/calendars?tab=tasks&amp;taskId=t1"');
  assertStringIncludes(m.html, ">Open task</a>");
  assertStringIncludes(m.text, "Task: Call <Acme>");
  assertStringIncludes(m.text, "Open task: https://os.example.com/calendars?tab=tasks&taskId=t1");
  assertStringIncludes(m.text, "Automated notification from Orion.");
});

Deno.test("works with no rows and no cta", () => {
  const m = buildNotificationEmail({ subject: "s", heading: "Heads up" });
  assert(!m.html.includes("<table"));
  assert(!m.html.includes("<a "));
  assertEquals(m.text, "Heads up\n\nAutomated notification from Orion.");
});
