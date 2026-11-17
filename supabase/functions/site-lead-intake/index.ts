/**
 * site-lead-intake — receiver for the business website's submissions (assessments, contact, lead_magnet).
 * Logic lives in ./handler.ts so it can be unit-tested; see its header and _shared/lead-magnet.ts.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handle } from "./handler.ts";

Deno.serve((req) => handle(req));
