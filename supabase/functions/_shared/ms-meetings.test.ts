import { assertEquals } from "jsr:@std/assert";
import { formatAiInsight, pickRecording, vttToText } from "./ms-meetings.ts";

Deno.test("vttToText flattens voice cues to Speaker: text and merges consecutive same-speaker cues", () => {
  const vtt = [
    "WEBVTT",
    "",
    "1",
    "00:00:01.000 --> 00:00:03.000",
    "<v Jordan Example>Thanks for joining.</v>",
    "",
    "2",
    "00:00:03.000 --> 00:00:05.000",
    "<v Jordan Example>Let's cover the roof scope.</v>",
    "",
    "3",
    "00:00:05.000 --> 00:00:07.000",
    "<v Jane Client>Sounds good, when can you start?</v>",
  ].join("\n");
  assertEquals(
    vttToText(vtt),
    "Jordan Example: Thanks for joining. Let's cover the roof scope.\nJane Client: Sounds good, when can you start?",
  );
});

Deno.test("vttToText handles cues without a speaker tag and strips stray markup", () => {
  const vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nplain line <i>italic</i> here";
  assertEquals(vttToText(vtt), "plain line italic here");
});

Deno.test("vttToText ignores NOTE blocks, indices and timestamps", () => {
  const vtt = "WEBVTT\n\nNOTE this is metadata\n\n7\n00:00:10.500 --> 00:00:12.000\n<v A>hi</v>";
  assertEquals(vttToText(vtt), "A: hi");
});

Deno.test("pickRecording matches a video in the meeting window, preferring the title", () => {
  const meeting = { title: "Roof scope call", startAt: "2026-10-20T14:00:00Z", endAt: "2026-10-20T15:00:00Z" };
  const items = [
    { id: "a", name: "Other-20261020_140100-Meeting Recording.mp4", createdDateTime: "2026-10-20T14:01:00Z", file: { mimeType: "video/mp4" } },
    { id: "b", name: "Roof scope call-20261020_140500-Meeting Recording.mp4", createdDateTime: "2026-10-20T14:05:00Z", size: 9, file: { mimeType: "video/mp4" } },
    { id: "c", name: "notes.docx", createdDateTime: "2026-10-20T14:02:00Z", file: { mimeType: "application/msword" } },
    { id: "d", name: "Roof scope call-old.mp4", createdDateTime: "2026-10-01T14:05:00Z", file: { mimeType: "video/mp4" } },
  ];
  assertEquals(pickRecording(items, meeting)?.id, "b");
  assertEquals(pickRecording(items.slice(0, 1), meeting)?.id, "a");
  assertEquals(pickRecording([items[2], items[3]], meeting), null);
});

Deno.test("formatAiInsight renders notes, subpoints and action items", () => {
  const t = formatAiInsight({
    meetingNotes: [{ title: "Scope", text: "Replace roof", subpoints: [{ title: "Material", text: "metal" }] }],
    actionItems: [{ title: "Send quote", text: "by Friday", ownerDisplayName: "Alex" }],
  });
  assertEquals(t, "- Scope: Replace roof\n  - Material: metal\nAction items:\n- Send quote: by Friday (owner: Alex)");
  assertEquals(formatAiInsight({}), "");
});
