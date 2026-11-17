import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { dialWhisper, enqueue, esc, gatherFragment, signTts, speak, startRecording, ttsSigValid } from "./twiml.ts";

Deno.test("speak escapes text and falls back to Polly without a TTS base", () => {
  assertEquals(speak('a & b <c> "d"'), '<Say voice="Polly.Joanna-Neural">a &amp; b &lt;c&gt; &quot;d&quot;</Say>');
});

Deno.test("speak uses a signed <Play> URL when TTS is healthy", () => {
  const x = speak("hi there", { ttsBase: "https://x/tts", sig: "abc", tone: "owner" });
  assertEquals(x, '<Play>https://x/tts?text=hi%20there&amp;sig=abc&amp;tone=owner</Play>');
});

Deno.test("gather nests the prompt so callers can barge in, then adds the no-input line", () => {
  const g = gatherFragment("Hello", "https://x/voice?rec=start&a=1", (t) => `<Say>${t}</Say>`);
  assertStringIncludes(g, '<Gather input="speech" speechTimeout="auto" action="https://x/voice?rec=start&amp;a=1" method="POST"><Say>Hello</Say></Gather><Say>I didn');
});

Deno.test("recording uses <Start><Recording>", () => {
  assertStringIncludes(startRecording("https://x/rec"), "<Start><Recording ");
  assertEquals(startRecording("https://x/rec").includes("<Record "), false);
});

Deno.test("enqueue and whispered dial carry their callbacks", () => {
  assertStringIncludes(enqueue({ queueName: "q 1", waitUrl: "https://w", actionUrl: "https://a" }), '<Enqueue waitUrl="https://w" waitUrlMethod="POST" action="https://a" method="POST">q 1</Enqueue>');
  assertStringIncludes(dialWhisper({ number: "+15551234567", whisperUrl: "https://w", actionUrl: "https://a", callerId: "+15550000000" }), '<Number url="https://w">+15551234567</Number>');
});

Deno.test("tts signatures verify and reject tampering", async () => {
  const sig = await signTts("hello", "secret");
  assertEquals(sig.length, 24);
  assertEquals(await ttsSigValid("hello", sig, "secret"), true);
  assertEquals(await ttsSigValid("hello!", sig, "secret"), false);
  assertEquals(await ttsSigValid("hello", null, "secret"), false);
  assertEquals(esc("&"), "&amp;");
});
