import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { openSecret, sealSecret } from "../_shared/secrets.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestPayload {
  action: "test-connection" | "sync-voices" | "preview-voice" | "save-key";
  /** Honored for SuperAdmin callers only; derived from the JWT otherwise. */
  org_id?: string;
  voice_id?: string;
  text?: string;
  api_key?: string;
  enabled?: boolean;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  description?: string;
  preview_url?: string;
  category?: string;
}

interface ElevenLabsVoicesResponse {
  voices: ElevenLabsVoice[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // Deployed verify_jwt=false, so the gateway lets anyone through - this endpoint had no check
  // of its own. Caller verified before adding this: the dashboard via callEdgeFunction.
  const authClient = getSupabaseClient();
  const userContext = await extractUserContext(req, authClient);
  if (!userContext) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const payload: RequestPayload = await req.json();
    const { action, voice_id, text } = payload;

    // The connection row below is read with the service-role client, so RLS does not scope
    // it: an org_id from the body let any authenticated user use another org's ElevenLabs
    // API key and overwrite that org's synced voices (F-25 pattern).
    if (payload.org_id && payload.org_id !== userContext.orgId && !userContext.isSuperAdmin) {
      console.warn(`[ai-settings-elevenlabs] org mismatch: body=${payload.org_id} caller=${userContext.orgId}`);
      return new Response(
        JSON.stringify({ success: false, error: "Not a member of this organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const org_id = userContext.isSuperAdmin
      ? (payload.org_id || userContext.orgId)
      : userContext.orgId;

    if (!action || !org_id) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // The key is written here, sealed, instead of by the browser (which can no longer touch it).
    if (action === "save-key") {
      if (!userContext.isSuperAdmin && !userContext.permissions.includes("ai_agents.manage")) {
        return new Response(
          JSON.stringify({ success: false, error: "You need the ai_agents.manage permission" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!payload.api_key?.trim()) {
        return new Response(
          JSON.stringify({ success: false, error: "API key is empty" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data, error } = await supabaseAdmin
        .from("elevenlabs_connection")
        .upsert({
          org_id,
          api_key_encrypted: await sealSecret(payload.api_key.trim()),
          enabled: payload.enabled ?? true,
          updated_at: new Date().toISOString(),
        }, { onConflict: "org_id" })
        .select("id, org_id, enabled, last_synced_at, created_at, updated_at")
        .single();
      if (error) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: true, connection: data }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: connection, error: connectionError } = await supabaseAdmin
      .from("elevenlabs_connection")
      .select("*")
      .eq("org_id", org_id)
      .single();

    if (connectionError || !connection) {
      return new Response(
        JSON.stringify({ success: false, error: "ElevenLabs not configured" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiKey = (await openSecret(connection.api_key_encrypted)) ?? "";

    if (action === "test-connection") {
      const result = await testConnection(apiKey);
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "sync-voices") {
      const result = await syncVoices(supabaseAdmin, org_id, apiKey);
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "preview-voice") {
      if (!voice_id || !text) {
        return new Response(
          JSON.stringify({ success: false, error: "voice_id and text are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const result = await previewVoice(apiKey, voice_id, text);
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: "Unknown action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in ai-settings-elevenlabs:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function testConnection(apiKey: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: "Invalid API key" };
      }
      return { success: false, error: `API returned status ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection test failed",
    };
  }
}

async function syncVoices(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  apiKey: string
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return { success: false, error: `Failed to fetch voices: ${response.status}` };
    }

    const data: ElevenLabsVoicesResponse = await response.json();
    const voices = data.voices || [];

    const { data: existingVoices } = await supabase
      .from("elevenlabs_voices")
      .select("voice_id, is_default")
      .eq("org_id", orgId);

    const existingMap = new Map(
      (existingVoices || []).map(v => [v.voice_id, v.is_default])
    );

    for (const voice of voices) {
      const existingIsDefault = existingMap.get(voice.voice_id);
      const metadata = {
        labels: voice.labels || {},
        description: voice.description || null,
        preview_url: voice.preview_url || null,
        category: voice.category || null,
      };

      if (existingMap.has(voice.voice_id)) {
        await supabase
          .from("elevenlabs_voices")
          .update({
            voice_name: voice.name,
            metadata,
          })
          .eq("org_id", orgId)
          .eq("voice_id", voice.voice_id);
      } else {
        await supabase
          .from("elevenlabs_voices")
          .insert({
            org_id: orgId,
            voice_id: voice.voice_id,
            voice_name: voice.name,
            enabled: true,
            is_default: false,
            metadata,
          });
      }
    }

    const syncedVoiceIds = voices.map(v => v.voice_id);
    const voicesToRemove = Array.from(existingMap.keys()).filter(
      id => !syncedVoiceIds.includes(id)
    );

    if (voicesToRemove.length > 0) {
      await supabase
        .from("elevenlabs_voices")
        .delete()
        .eq("org_id", orgId)
        .in("voice_id", voicesToRemove);
    }

    return { success: true, count: voices.length };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to sync voices",
    };
  }
}

async function previewVoice(
  apiKey: string,
  voiceId: string,
  text: string
): Promise<{ audioUrl?: string; error?: string }> {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.slice(0, 500),
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
          },
        }),
      }
    );

    if (!response.ok) {
      return { error: `Failed to generate audio: ${response.status}` };
    }

    const audioBuffer = await response.arrayBuffer();
    const base64Audio = btoa(
      String.fromCharCode(...new Uint8Array(audioBuffer))
    );
    const audioUrl = `data:audio/mpeg;base64,${base64Audio}`;

    return { audioUrl };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to preview voice",
    };
  }
}
