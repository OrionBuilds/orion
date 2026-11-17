import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { transcribeAudio, isTranscribeError } from "../_shared/elevenLabsStt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_FILE_SIZE = 10_485_760;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonRes({ error: "Unauthorized" }, 401);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const {
      data: { user },
      error: authErr,
    } = await anonClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return jsonRes({ error: "Unauthorized" }, 401);

    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) return jsonRes({ error: "No audio file provided" }, 400);
    if (audioFile.size > MAX_FILE_SIZE) {
      return jsonRes({ error: "Audio too large (max 10MB)" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const { data: userRow } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .maybeSingle();
    const orgId = (userRow?.organization_id as string | undefined) ?? null;

    const result = await transcribeAudio(supabase, orgId, audioFile, {
      filename: "command.webm",
    });

    if (isTranscribeError(result)) {
      console.error("[assistant-stt-final] Transcription error:", result.error);
      return jsonRes({ error: `Transcription failed: ${result.error}` }, 500);
    }

    return jsonRes({ text: result.text || "", confidence: result.confidence ?? 1.0 });
  } catch (err) {
    console.error("[assistant-stt-final] Error:", err);
    return jsonRes(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
