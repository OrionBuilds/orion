/**
 * caio-meeting-watch — cron (X-Cron-Secret). Finds OS meetings with a transcript that the watcher has not seen, matches the
 * attendees to a CAIO engagement's contact by email, and asks the owner to confirm consent (matched) or to link it (not matched).
 * Never writes to meeting_transcriptions; a matched meeting is never processed before the owner attests consent.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { isCronRequest } from "../_shared/auth.ts";
import { denoEnv, serviceClient } from "../_shared/clara/webhook.ts";
import { claraNumberFor, notifyDeps } from "../_shared/clara/runtime.ts";
import { notifyOwner } from "../_shared/clara/notify.ts";
import { watchMeetings } from "../_shared/caio/meeting-match.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (!isCronRequest(req)) return json({ error: "Unauthorized" }, 401);
  if ((denoEnv.get("CAIO_AUTOMATION") ?? "").trim().toLowerCase() === "off") return json({ ok: true, skipped: "kill_switch" });
  const db = serviceClient();
  try {
    const res = await watchMeetings(db, {
      now: new Date(),
      notify: async (orgId, n) => {
        await notifyOwner(db, { kind: n.kind, priority: "normal", text: n.text, dedupeKey: n.dedupeKey }, notifyDeps(db, denoEnv, orgId, await claraNumberFor(db, denoEnv, orgId)));
      },
    });
    if (res.errors.length) console.warn("[caio-meeting-watch]", res.errors.slice(0, 5).join(" | "));
    return json({ ok: true, ...res });
  } catch (e) {
    console.error("[caio-meeting-watch]", (e as Error).message.slice(0, 200));
    return json({ ok: false, error: "Meeting watch failed" }, 500);
  }
});
