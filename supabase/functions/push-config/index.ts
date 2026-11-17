/** push-config: the VAPID public key the browser needs to subscribe (signed-in users only; the public key is not secret). */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  return new Response(JSON.stringify({ publicKey, configured: publicKey.length > 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
