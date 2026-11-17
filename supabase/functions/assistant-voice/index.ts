// DEPRECATED — B6 (Clara decommission): the in-app assistant voice UI that called this function is
// retired. Stays deployed-but-unreachable-from-UI on purpose (soft-decommission; still callable via
// the MCP assistant_voice tool). NOT to be confused with assistant-meeting-processor, which remains
// live for the /meetings "Send to Memory" flow. Replacement: the external CLARA app via MCP.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { transcribeAudio, isTranscribeError } from "../_shared/elevenLabsStt.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data: { user }, error: authErr } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;
    const threadId = formData.get("thread_id") as string;
    const contextStr = formData.get("context") as string;

    if (!audioFile) return json({ error: "No audio file provided" }, 400);
    if (!threadId) return json({ error: "thread_id required" }, 400);

    const { data: userRow } = await supabase
      .from("users")
      .select("organization_id")
      .eq("id", user.id)
      .maybeSingle();
    const orgId = (userRow?.organization_id as string | undefined) ?? null;

    const sttResult = await transcribeAudio(supabase, orgId, audioFile, {
      filename: "recording.webm",
    });

    if (isTranscribeError(sttResult)) {
      return json({ error: `Transcription failed: ${sttResult.error}` }, 500);
    }

    const transcription = sttResult.text || "";

    if (!transcription.trim()) {
      return json({
        transcription: "",
        response: "I didn't catch that. Could you try again?",
        tool_calls: [],
        confirmations_pending: [],
        drafts: [],
      });
    }

    const context = contextStr ? JSON.parse(contextStr) : {};

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const chatUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/assistant-chat`;
    const chatRes = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        thread_id: threadId,
        content: transcription,
        context,
        internal_user_id: user.id,
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      return json({
        transcription,
        response: `I understood "${transcription}" but encountered an error processing it.`,
        tool_calls: [],
        confirmations_pending: [],
        drafts: [],
      });
    }

    const chatData = await chatRes.json();

    return json({
      transcription,
      response: chatData.response,
      tool_calls: chatData.tool_calls || [],
      confirmations_pending: chatData.confirmations_pending || [],
      drafts: chatData.drafts || [],
    });
  } catch (err) {
    console.error("[assistant-voice] Error:", err);
    return json(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
