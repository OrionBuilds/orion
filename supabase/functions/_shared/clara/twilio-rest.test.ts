import { assertEquals } from "jsr:@std/assert@1";
import { deleteQueueByName, placeCall, queuePageSearch, redirectCall } from "./twilio-rest.ts";

const auth = { accountSid: "AC1", authToken: "tok" };

Deno.test("placeCall sends recording-free, machine-detected owner leg params", async () => {
  let seen: { url: string; body: string; auth: string | null } | null = null;
  const f = ((url: string, init: RequestInit) => {
    seen = { url, body: String(init.body), auth: new Headers(init.headers).get("Authorization") };
    return Promise.resolve(new Response(JSON.stringify({ sid: "CA9" }), { status: 201 }));
  }) as unknown as typeof fetch;
  const r = await placeCall(auth, "+1000", "+1111", { url: "https://x/answer" }, {
    machineDetection: "Enable", machineDetectionTimeoutSec: 1, timeoutSec: 15,
    statusCallback: "https://x/s", statusCallbackEvent: ["completed"],
  }, f);
  assertEquals(r, { ok: true, sid: "CA9" });
  const p = new URLSearchParams(seen!.body);
  assertEquals([p.get("MachineDetection"), p.get("MachineDetectionTimeout"), p.get("Timeout"), p.get("Record")], ["Enable", "3", "15", null]);
  assertEquals(seen!.auth, "Basic " + btoa("AC1:tok"));
});

Deno.test("placeCall needs twiml or url", async () => {
  assertEquals((await placeCall(auth, "+1", "+2", {})).ok, false);
});

Deno.test("redirect reports failure when the call is already over", async () => {
  const f = (() => Promise.resolve(new Response("gone", { status: 404 }))) as unknown as typeof fetch;
  const r = await redirectCall(auth, "CA1", "https://x/return", f);
  assertEquals(r.ok, false);
});

Deno.test("queue lookup follows pages and strips the account prefix", async () => {
  assertEquals(queuePageSearch(JSON.stringify({ queues: [{ sid: "QU1", friendly_name: "a" }], next_page_uri: "/2010-04-01/Accounts/AC1/Queues.json?Page=1" }), "zzz"),
    { sid: null, nextPath: "/Queues.json?Page=1" });
  let n = 0;
  const calls: string[] = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url.replace(/.*Accounts\/AC1/, "")}`);
    if (init.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    n++;
    return Promise.resolve(new Response(JSON.stringify(n === 1
      ? { queues: [], next_page_uri: "/2010-04-01/Accounts/AC1/Queues.json?Page=1" }
      : { queues: [{ sid: "QU7", friendly_name: "hold-1" }], next_page_uri: null })));
  }) as unknown as typeof fetch;
  assertEquals(await deleteQueueByName(auth, "hold-1", f), true);
  assertEquals(calls.at(-1), "DELETE /Queues/QU7.json");
});
