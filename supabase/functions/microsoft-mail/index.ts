/**
 * microsoft-mail — user-facing Outlook mailbox actions for the OS UI (the Microsoft counterpart to
 * gmail-api). Authenticated as the signed-in user; acts through their own Microsoft connection.
 * Actions: send, reply, create-draft, update-draft, delete-draft, send-draft, get-thread,
 * get-message, trash, archive, move, mark-read, set-flag, set-categories, list-attachments,
 * get-attachment, list-folders.
 *
 * Several Microsoft accounts: `from_connection_id` (alias `connection_id`) picks the account; it must be the caller's
 * (403 otherwise). send defaults to the primary; reply and the message actions default to the mailbox the message arrived on.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { extractUserContext, getSupabaseClient } from "../_shared/auth.ts";
import { getValidAccessToken } from "../_shared/ms-graph.ts";
import { dispatchMail, MailSelectorError, resolveMailConnection } from "../_shared/mail-dispatch.ts";
import {
  createDraft, deleteDraft, getAttachment, getMessage, listAttachments, listMailFolders, listThread,
  moveMessage, sendDraft, setCategories, setFlag, setRead, trashMessage, updateDraft,
} from "../_shared/ms-mail-ops.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
// Graph immutable ids for messages we hold are stored as "ms:<id>"; strip the prefix for Graph calls.
const bare = (id: string) => (id?.startsWith("ms:") ? id.slice(3) : id);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = getSupabaseClient();
  const ctx = await extractUserContext(req, supabase);
  if (!ctx) return json({ error: "Unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action = String(body.action ?? "");
  const ownerCc = Deno.env.get("OWNER_CC_EMAIL")?.trim() || null;

  try {
    const id = body.messageId ? bare(String(body.messageId)) : "";
    const picked = body.from_connection_id ?? body.connection_id;
    const fromConnectionId = typeof picked === "string" && picked ? picked : null;
    // send/reply resolve their own token in dispatchMail; every other action acts in one mailbox.
    const token = async () => {
      const connectionId = await resolveMailConnection(supabase, ctx.id, { connectionId: fromConnectionId, messageId: id || null, orgId: ctx.homeOrgId ?? ctx.orgId ?? null });
      return connectionId ? getValidAccessToken(supabase, ctx.id, { connectionId }) : getValidAccessToken(supabase, ctx.id);
    };
    switch (action) {
      case "send":
        return json({ success: true, ...(await dispatchMail(supabase, { userId: ctx.id, mail: { to: body.to as string[] ?? [], cc: body.cc as string[], bcc: body.bcc as string[], subject: String(body.subject ?? ""), body: String(body.body ?? ""), contentType: body.contentType as "text" | "html" }, ownerEmail: ownerCc, fromConnectionId })) });
      case "reply":
        return json({ success: true, ...(await dispatchMail(supabase, { userId: ctx.id, replyToMessageId: id, mail: { to: [], subject: "", body: String(body.body ?? body.comment ?? "") }, ownerEmail: ownerCc, fromConnectionId })) });
      case "create-draft":
        return json(await createDraft(await token(), draftFrom(body)));
      case "update-draft":
        await updateDraft(await token(), id, draftFrom(body));
        return json({ success: true });
      case "delete-draft":
        await deleteDraft(await token(), id);
        return json({ success: true });
      case "send-draft":
        await sendDraft(await token(), id);
        return json({ success: true });
      case "get-thread":
        return json(await listThread(await token(), String(body.threadId ?? body.conversationId ?? "")));
      case "get-message":
        return json(await getMessage(await token(), id));
      case "trash":
        await trashMessage(await token(), id);
        return json({ success: true });
      case "archive":
        await moveMessage(await token(), id, "archive");
        return json({ success: true });
      case "move":
        await moveMessage(await token(), id, String(body.destinationId ?? "inbox"));
        return json({ success: true });
      case "mark-read":
        await setRead(await token(), id, body.isRead !== false);
        return json({ success: true });
      case "set-flag":
        await setFlag(await token(), id, body.flagged !== false);
        return json({ success: true });
      case "set-categories":
      case "modify-labels":
        await setCategories(await token(), id, (body.categories as string[]) ?? (body.addLabelIds as string[]) ?? []);
        return json({ success: true });
      case "list-attachments":
        return json({ attachments: await listAttachments(await token(), id) });
      case "get-attachment":
        return json(await getAttachment(await token(), id, String(body.attachmentId ?? "")));
      case "list-folders":
        return json({ folders: await listMailFolders(await token()) });
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error("[microsoft-mail]", action, e);
    if (e instanceof MailSelectorError) return json({ success: false, error: e.message }, 403);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});

function draftFrom(b: Record<string, unknown>) {
  return {
    to: (b.to as string[]) ?? [], cc: b.cc as string[], bcc: b.bcc as string[],
    subject: String(b.subject ?? ""), body: String(b.body ?? ""), contentType: b.contentType as "text" | "html",
  };
}
