// clara-app — over-the-air updates and remote settings for Clara's Android app.
//
// GET with the device key (x-clara-device-key). Returns:
//   app     the newest published build (versionCode, versionName, sha256, size) + a 1-hour signed download URL
//   config  live voice settings (speed, voice, wake phrases, timings) the app applies without an update
// Everything lives in the private `clara-app` Storage bucket: manifest.json (written by ~/clara-voice/publish.sh),
// config.json (edit it to change her settings on every phone at once) and builds/<versionCode>.apk.
// The app checks the sha256 before installing, so a swapped file is refused on the phone as well.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getSupabaseClient } from "../_shared/auth.ts";
import { deviceKeyOk } from "../_shared/clara/device-key.ts";

const BUCKET = "clara-app";
const DEFAULT_CONFIG = {
  voiceSid: 22, voiceSpeed: 1.1, wakePhrases: ["hey clara", "clara are you there", "clara"],
  followupMs: 6000, endSilenceMs: 700, updateCheckHours: 6,
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// deno-lint-ignore no-explicit-any
async function readJson(svc: any, path: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await svc.storage.from(BUCKET).download(path);
  if (error || !data) return null;
  try { return JSON.parse(await data.text()); } catch { return null; }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET") return json({ error: "Use GET" }, 405);
  if (!deviceKeyOk(req.headers.get("x-clara-device-key"), Deno.env.get("CLARA_VOICE_DEVICE_KEY"))) return json({ error: "Unauthorized" }, 401);
  const svc = getSupabaseClient();

  const manifest = await readJson(svc, "manifest.json");
  const config = { ...DEFAULT_CONFIG, ...((await readJson(svc, "config.json")) ?? {}) };

  let app: Record<string, unknown> | null = null;
  if (manifest && typeof manifest.path === "string") {
    const { data: signed } = await svc.storage.from(BUCKET).createSignedUrl(manifest.path, 3600);
    if (signed?.signedUrl) {
      app = {
        versionCode: manifest.versionCode, versionName: manifest.versionName,
        sha256: manifest.sha256, size: manifest.size, notes: manifest.notes ?? "", url: signed.signedUrl,
      };
    }
  }
  return json({ app, config });
});
