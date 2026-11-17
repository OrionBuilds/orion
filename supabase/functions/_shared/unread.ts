/**
 * Unread counts for customer conversations.
 *
 * A reply the owner sends from Outlook or Gmail reaches the OS through the mailbox sync as an outbound message. That
 * reply means the customer's mail was read, so the conversation's unread count clears, as it does when the thread is
 * opened in the OS. Without this, mail answered outside the OS kept counting on the Inbox badge for weeks.
 *
 * Mail sent from an agent's mailbox (Clara, FRIDAY: users with an agent team channel) does not clear it; the owner
 * still hasn't seen what the customer wrote. Neither does an older sent item imported after a newer customer mail
 * (history backfill), since that reply doesn't answer the newer mail.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function isAgentUser(supabase: SupabaseClient, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabase.from("team_channels").select("id").eq("agent_user_id", userId).limit(1).maybeSingle();
  return !!data;
}

/** True when a sent mail at `sentAt` from `senderUserId`'s mailbox should clear the conversation's unread count. */
export async function replyClearsUnread(
  supabase: SupabaseClient,
  conversationId: string,
  senderUserId: string | null | undefined,
  sentAt: string,
): Promise<boolean> {
  if (!senderUserId || await isAgentUser(supabase, senderUserId)) return false;
  const { data } = await supabase.from("messages").select("sent_at")
    .eq("conversation_id", conversationId).eq("direction", "inbound")
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  const lastInbound = (data as { sent_at: string | null } | null)?.sent_at;
  return !lastInbound || new Date(lastInbound).getTime() <= new Date(sentAt).getTime();
}
