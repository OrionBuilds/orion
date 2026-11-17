/**
 * The owner texting Clara's number (native handler; replaces the relay to the CLARA app).
 *
 * Order matters and each step can end it:
 *   1. A live work-line hold owns a bare "1"/"2" (hold.tryHandleHoldReply) so it can never be
 *      mistaken for a command.
 *   2. Anything else is an owner request and goes to the owner brain (owner-turn.ts), which DOES
 *      the work (task, email, text, FRIDAY handoff, calendar) and replies with what actually
 *      happened.
 *
 * Returns the reply to text back, or null for "send nothing".
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type HoldDeps, tryHandleHoldReply } from "./hold.ts";

export interface OwnerSmsInput { body: string; messageSid?: string | null }

export async function handleOwnerSms(
  db: SupabaseClient, i: OwnerSmsInput, d: { hold: HoldDeps; run: (text: string) => Promise<string> },
): Promise<string | null> {
  const body = (i.body ?? "").trim();
  if (!body) return null;

  const holdReply = await tryHandleHoldReply(db, body, d.hold);
  if (holdReply !== null) return holdReply.slice(0, 600);

  return (await d.run(body)).slice(0, 1500);
}
