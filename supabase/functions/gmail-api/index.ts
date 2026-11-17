import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildRawEmail,
  bytesToBase64,
  GMAIL_API_URL,
  type RawEmailAttachment,
} from "../_shared/gmail-helpers.ts";
import {
  fetchAcrossMailboxes,
  getMailboxToken,
  MailboxSelectError,
  resolveApiMailbox,
  type GmailMailbox,
} from "../_shared/gmail-mailbox.ts";

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

interface AttachmentRef {
  bucket?: string;
  path: string;
  filename: string;
  mimeType?: string;
  size?: number;
}

/** Download outbound attachments from storage (service role) and base64-encode
 *  them for the MIME builder. Skips any that fail to download. */
async function loadAttachments(
  supabase: SupabaseClient,
  attachments?: AttachmentRef[]
): Promise<RawEmailAttachment[]> {
  if (!attachments?.length) return [];
  const out: RawEmailAttachment[] = [];
  for (const a of attachments) {
    const bucket = a.bucket || "email-attachments";
    const { data, error } = await supabase.storage.from(bucket).download(a.path);
    if (error || !data) {
      console.error("[gmail-api] attachment download failed:", a.path, error?.message);
      continue;
    }
    const bytes = new Uint8Array(await data.arrayBuffer());
    out.push({
      filename: a.filename,
      mimeType: a.mimeType || "application/octet-stream",
      base64: bytesToBase64(bytes),
    });
  }
  return out;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 400) {
  return jsonResponse({ error: message }, status);
}

/**
 * Fetch the user's Gmail signature for their primary send-as address.
 * Returns the signature HTML or empty string if none is set.
 * Uses Gmail's settings.sendAs API endpoint.
 */
async function getGmailSignature(
  accessToken: string,
  fromEmail: string
): Promise<string> {
  try {
    const res = await fetch(
      `${GMAIL_API_URL}/users/me/settings/sendAs/${encodeURIComponent(fromEmail)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!res.ok) {
      // Try the primary address if the specific one fails
      const fallbackRes = await fetch(
        `${GMAIL_API_URL}/users/me/settings/sendAs`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!fallbackRes.ok) return "";
      const fallbackData = await fallbackRes.json();
      const primary = (fallbackData.sendAs ?? []).find(
        (sa: { isPrimary?: boolean }) => sa.isPrimary
      );
      return primary?.signature ?? "";
    }
    const data = await res.json();
    return data.signature ?? "";
  } catch (err) {
    console.error("[gmail-api] Failed to fetch signature:", err);
    return "";
  }
}

/**
 * Append the Gmail signature to the email body with a separator.
 */
function appendSignature(htmlBody: string, signature: string): string {
  if (!signature) return htmlBody;
  return `${htmlBody}<br><br><div class="gmail_signature_separator">--</div><div class="gmail_signature">${signature}</div>`;
}

function getAnonClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getServiceRoleClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      return errorResponse("Missing server configuration", 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("[GmailAPI] No Authorization header");
      return errorResponse("Unauthorized", 401);
    }

    const token = authHeader.replace("Bearer ", "");

    // Use anon client for JWT validation
    const anonClient = getAnonClient();
    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser(token);

    if (authError || !user) {
      console.error("[GmailAPI] JWT validation failed:", authError?.message);
      return errorResponse("Unauthorized", 401);
    }

    // Use service role client for database operations
    const supabase = getServiceRoleClient();

    const { data: userData } = await supabase
      .from("users")
      .select("id, organization_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!userData) {
      return errorResponse("User not found", 404);
    }

    const body = await req.json();
    const { action } = body;

    // Which of the caller's Google accounts this call runs on. send/reply take `from_connection_id`, every other action
    // `connection_id`; a foreign id is refused (403). A reply defaults to the mailbox the thread arrived on, else the
    // primary; a new message and everything else default to the primary.
    const isSending = action === "send" || action === "reply";
    const explicitId: string | null = (isSending ? body.from_connection_id ?? body.connection_id : body.connection_id) || null;
    let mailbox: GmailMailbox;
    try {
      mailbox = await resolveApiMailbox(supabase, userData.id, userData.organization_id, {
        connectionId: explicitId,
        replyThreadId: action === "reply" ? body.threadId ?? null : null,
      });
    } catch (e) {
      if (e instanceof MailboxSelectError) return errorResponse(e.message, e.status);
      throw e;
    }

    const accessToken = await getMailboxToken(supabase, mailbox);
    // stamped on the OS message rows this function writes: which Google mailbox they belong to
    const mailboxStamp = { mailbox_email: mailbox.email, mailbox_google_connection_id: mailbox.connectionId };

    switch (action) {
      case "get-profile": {
        const res = await fetch(`${GMAIL_API_URL}/users/me/profile`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok)
          return errorResponse("Failed to get Gmail profile", res.status);
        return jsonResponse(await res.json());
      }

      case "list-messages": {
        const { query = "", maxResults = 20, pageToken } = body;
        const params = new URLSearchParams({
          q: query,
          maxResults: String(maxResults),
        });
        if (pageToken) params.set("pageToken", pageToken);

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/messages?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!res.ok)
          return errorResponse("Failed to list messages", res.status);
        return jsonResponse(await res.json());
      }

      case "get-message": {
        const { messageId, format = "full" } = body;
        if (!messageId) return errorResponse("messageId required");

        const res = await fetchAcrossMailboxes(
          supabase,
          mailbox,
          accessToken,
          (at) =>
            fetch(
              `${GMAIL_API_URL}/users/me/messages/${messageId}?format=${format}`,
              { headers: { Authorization: `Bearer ${at}` } }
            )
        );
        if (!res.ok)
          return errorResponse("Failed to get message", res.status);
        return jsonResponse(await res.json());
      }

      case "get-thread": {
        const { threadId } = body;
        if (!threadId) return errorResponse("threadId required");

        const res = await fetchAcrossMailboxes(
          supabase,
          mailbox,
          accessToken,
          (at) =>
            fetch(`${GMAIL_API_URL}/users/me/threads/${threadId}?format=full`, {
              headers: { Authorization: `Bearer ${at}` },
            })
        );
        if (!res.ok)
          return errorResponse("Failed to get thread", res.status);
        return jsonResponse(await res.json());
      }

      case "send": {
        const {
          to,
          cc,
          bcc,
          subject,
          htmlBody,
          threadId,
          inReplyTo,
          references,
        } = body;
        if (!to || !subject || !htmlBody)
          return errorResponse("to, subject, htmlBody required");

        // The operator (or workflow) is responsible for the full body content.
        // We no longer auto-append the user's Gmail send-as signature — workflow
        // sends had no way to opt out and the result was inconsistent rendering
        // (signatures with embedded images dominated short transactional bodies).
        const sendAttachments = await loadAttachments(supabase, body.attachments);
        const raw = buildRawEmail({
          to,
          cc,
          bcc,
          subject,
          body: htmlBody,
          inReplyTo,
          references,
          fromEmail: mailbox.email,
          attachments: sendAttachments,
        });

        const sendBody: Record<string, string> = { raw };
        if (threadId) sendBody.threadId = threadId;

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/messages/send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(sendBody),
          }
        );

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResponse(
            err.error?.message || "Failed to send email",
            res.status
          );
        }

        const sentMsg = await res.json();

        if (body.conversationId && body.contactId) {
          await supabase.from("messages").insert({
            organization_id: userData.organization_id,
            conversation_id: body.conversationId,
            contact_id: body.contactId,
            channel: "email",
            direction: "outbound",
            body: htmlBody.substring(0, 256000),
            subject,
            metadata: {
              from_email: mailbox.email,
              to_emails: to.split(",").map((s: string) => s.trim()),
              cc_emails: cc
                ? cc.split(",").map((s: string) => s.trim())
                : [],
              bcc_emails: bcc
                ? bcc.split(",").map((s: string) => s.trim())
                : [],
              thread_id: sentMsg.threadId,
              gmail_message_id: sentMsg.id,
              sent_via: "gmail",
              attachments: ((body.attachments || []) as AttachmentRef[]).map((a) => ({
                filename: a.filename,
                path: a.path,
                bucket: a.bucket || "email-attachments",
                mimeType: a.mimeType,
                size: a.size,
              })),
            },
            status: "delivered",
            external_id: sentMsg.id,
            ...mailboxStamp,
            sent_at: new Date().toISOString(),
          });

          await supabase
            .from("conversations")
            .update({
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", body.conversationId);
        }

        return jsonResponse(sentMsg);
      }

      case "reply": {
        const {
          to,
          cc,
          bcc,
          subject,
          htmlBody,
          threadId,
          inReplyTo,
          references,
        } = body;
        if (!to || !htmlBody || !threadId)
          return errorResponse("to, htmlBody, threadId required");

        // Signature auto-append disabled — see send case above.
        const replySubject = subject || "";
        const replyAttachments = await loadAttachments(supabase, body.attachments);
        const raw = buildRawEmail({
          to,
          cc,
          bcc,
          subject: replySubject,
          body: htmlBody,
          inReplyTo,
          references,
          fromEmail: mailbox.email,
          attachments: replyAttachments,
        });

        const doSend = async (withThreadId: boolean) => {
          const sendBody: Record<string, string> = { raw };
          if (withThreadId && threadId) sendBody.threadId = threadId;
          return await fetch(`${GMAIL_API_URL}/users/me/messages/send`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(sendBody),
          });
        };

        let res = await doSend(true);
        let threadIdFallbackUsed = false;

        // Gmail returns 404 "Requested entity was not found" when the threadId
        // doesn't exist in the *signed-in user's* mailbox. Gmail threadIds are
        // mailbox-scoped — when User A synced a conversation first, the stored
        // threadId belongs to A's mailbox, so User B replying via their own
        // OAuth token 404s. Retry once without threadId; the In-Reply-To /
        // References headers (passed through buildRawEmail) still let the
        // recipient's client thread the message correctly.
        if (res.status === 404) {
          console.log(
            `[gmail-api reply] threadId ${threadId} not in ${mailbox.email}'s mailbox — retrying without threadId`
          );
          res = await doSend(false);
          threadIdFallbackUsed = true;
        }

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResponse(
            err.error?.message || "Failed to send reply",
            res.status
          );
        }

        const sentMsg = await res.json();

        // If we fell back (or Gmail returned a different threadId for any
        // reason), refresh conversations.external_thread_id so subsequent
        // replies in this user's mailbox use the threadId that actually exists.
        if (
          body.conversationId &&
          sentMsg.threadId &&
          (threadIdFallbackUsed || sentMsg.threadId !== threadId)
        ) {
          await supabase
            .from("conversations")
            .update({ external_thread_id: sentMsg.threadId })
            .eq("id", body.conversationId);
        }

        if (body.conversationId && body.contactId) {
          await supabase.from("messages").insert({
            organization_id: userData.organization_id,
            conversation_id: body.conversationId,
            contact_id: body.contactId,
            channel: "email",
            direction: "outbound",
            body: htmlBody.substring(0, 256000),
            subject: replySubject,
            metadata: {
              from_email: mailbox.email,
              to_emails: to.split(",").map((s: string) => s.trim()),
              cc_emails: cc
                ? cc.split(",").map((s: string) => s.trim())
                : [],
              bcc_emails: bcc
                ? bcc.split(",").map((s: string) => s.trim())
                : [],
              thread_id: sentMsg.threadId,
              gmail_message_id: sentMsg.id,
              sent_via: "gmail",
              attachments: ((body.attachments || []) as AttachmentRef[]).map((a) => ({
                filename: a.filename,
                path: a.path,
                bucket: a.bucket || "email-attachments",
                mimeType: a.mimeType,
                size: a.size,
              })),
            },
            status: "delivered",
            external_id: sentMsg.id,
            ...mailboxStamp,
            sent_at: new Date().toISOString(),
          });

          await supabase
            .from("conversations")
            .update({
              last_message_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", body.conversationId);
        }

        return jsonResponse(sentMsg);
      }

      case "create-draft": {
        const { to, cc, bcc, subject, htmlBody, threadId } = body;
        const raw = buildRawEmail({
          to: to || "",
          cc,
          bcc,
          subject: subject || "",
          body: htmlBody || "",
          fromEmail: mailbox.email,
        });

        const draftBody: Record<string, unknown> = { message: { raw } };
        if (threadId)
          (draftBody.message as Record<string, string>).threadId = threadId;

        const res = await fetch(`${GMAIL_API_URL}/users/me/drafts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(draftBody),
        });

        if (!res.ok)
          return errorResponse("Failed to create draft", res.status);
        return jsonResponse(await res.json());
      }

      case "update-draft": {
        const { draftId, to, cc, bcc, subject, htmlBody, threadId } = body;
        if (!draftId) return errorResponse("draftId required");

        const raw = buildRawEmail({
          to: to || "",
          cc,
          bcc,
          subject: subject || "",
          body: htmlBody || "",
          fromEmail: mailbox.email,
        });

        const draftBody: Record<string, unknown> = { message: { raw } };
        if (threadId)
          (draftBody.message as Record<string, string>).threadId = threadId;

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/drafts/${draftId}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(draftBody),
          }
        );

        if (!res.ok)
          return errorResponse("Failed to update draft", res.status);
        return jsonResponse(await res.json());
      }

      case "delete-draft": {
        const { draftId } = body;
        if (!draftId) return errorResponse("draftId required");

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/drafts/${draftId}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );

        if (!res.ok && res.status !== 404)
          return errorResponse("Failed to delete draft", res.status);
        return jsonResponse({ success: true });
      }

      case "list-drafts": {
        const { maxResults = 20, pageToken } = body;
        const params = new URLSearchParams({
          maxResults: String(maxResults),
        });
        if (pageToken) params.set("pageToken", pageToken);

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/drafts?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!res.ok)
          return errorResponse("Failed to list drafts", res.status);
        return jsonResponse(await res.json());
      }

      case "trash": {
        const { messageId } = body;
        if (!messageId) return errorResponse("messageId required");

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/messages/${messageId}/trash`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!res.ok)
          return errorResponse("Failed to trash message", res.status);
        return jsonResponse(await res.json());
      }

      case "archive": {
        const { messageId } = body;
        if (!messageId) return errorResponse("messageId required");

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/messages/${messageId}/modify`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
          }
        );
        if (!res.ok)
          return errorResponse("Failed to archive message", res.status);
        return jsonResponse(await res.json());
      }

      case "modify-labels": {
        const { messageId, addLabelIds, removeLabelIds } = body;
        if (!messageId) return errorResponse("messageId required");

        const res = await fetch(
          `${GMAIL_API_URL}/users/me/messages/${messageId}/modify`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ addLabelIds, removeLabelIds }),
          }
        );
        if (!res.ok)
          return errorResponse("Failed to modify labels", res.status);
        return jsonResponse(await res.json());
      }

      case "get-attachment": {
        const { messageId, attachmentId } = body;
        if (!messageId || !attachmentId)
          return errorResponse("messageId and attachmentId required");

        const res = await fetchAcrossMailboxes(
          supabase,
          mailbox,
          accessToken,
          (at) =>
            fetch(
              `${GMAIL_API_URL}/users/me/messages/${messageId}/attachments/${attachmentId}`,
              { headers: { Authorization: `Bearer ${at}` } }
            )
        );

        if (!res.ok)
          return errorResponse("Failed to fetch attachment", res.status);

        const attData = await res.json();

        const { data: attMeta } = await supabase
          .from("gmail_attachments")
          .select("filename, mime_type")
          .eq("gmail_message_id", messageId)
          .eq("attachment_id", attachmentId)
          .maybeSingle();

        const base64Data = (attData.data as string)
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const mimeType = attMeta?.mime_type || "application/octet-stream";
        const filename = attMeta?.filename || "attachment";

        return new Response(bytes, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": mimeType,
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      }

      case "list-attachments": {
        const { messageId } = body;
        if (!messageId) return errorResponse("messageId required");

        // Scoped to the org, not the caller: the synced message may belong to a
        // teammate's connected mailbox, and the conversation is already shared
        // org-wide. Filtering by user_id returned zero rows for those threads.
        const { data: attachments, error: attErr } = await supabase
          .from("gmail_attachments")
          .select("*")
          .eq("gmail_message_id", messageId)
          .eq("organization_id", userData.organization_id);

        if (attErr)
          return errorResponse("Failed to list attachments", 500);

        return jsonResponse(attachments || []);
      }

      default:
        return errorResponse(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error("gmail-api error:", err);
    return errorResponse(
      (err as Error).message || "An error occurred",
      500
    );
  }
});
