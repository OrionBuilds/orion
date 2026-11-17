// booking-email
//
// Sends transactional booking emails (confirmation / rescheduled / canceled) for
// the public anonymous booking flow. Calls Resend directly because the standard
// email-send function requires a user JWT (which the anonymous booking flow does
// not have).
//
// Auth: callers MUST pass `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`.
// Intended to be invoked fire-and-forget from booking-api.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getResendEnvCreds, toResendAttachments } from "../_shared/resend.ts";
import { loadOrgEmailDefaults, sendOrgEmail } from "../_shared/email-defaults.ts";
import { resolveBrandSender } from "../_shared/brands.ts";
import { buildIcs } from "../_shared/calendar-invite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Action = "confirmation" | "rescheduled" | "canceled" | "reminder";

function formatDateTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: tz,
  });
}

function locationLine(
  type: string | null,
  value: string | null,
  meetLink: string | null
): string {
  if (meetLink) return `Google Meet: <a href="${meetLink}" style="color:#0891b2;">${meetLink}</a>`;
  switch (type) {
    case "google_meet":
      return "Google Meet (link will be shared shortly)";
    case "zoom":
      return value ? `Zoom: <a href="${value}" style="color:#0891b2;">${value}</a>` : "Zoom video call";
    case "phone":
      return value ? `Phone: ${value}` : "Phone call";
    case "in_person":
      return value ? `In person: ${value}` : "In-person meeting";
    default:
      return "";
  }
}

function buildBody(args: {
  action: Action;
  contactName: string;
  apptTypeName: string;
  startLocal: string;
  durationMin: number;
  locationHtml: string;
  rescheduleUrl: string;
  cancelUrl: string;
  orgName: string;
}): { subject: string; html: string } {
  const { action, contactName, apptTypeName, startLocal, durationMin } = args;

  const headerByAction: Record<Action, { title: string; intro: string; subjectPrefix: string }> = {
    confirmation: {
      title: "Booking Confirmed",
      intro: "Your appointment is on the calendar. We're looking forward to it.",
      subjectPrefix: "Booking confirmed",
    },
    rescheduled: {
      title: "Booking Rescheduled",
      intro: "Your appointment has been moved to a new time.",
      subjectPrefix: "Booking rescheduled",
    },
    canceled: {
      title: "Booking Canceled",
      intro: "Your appointment has been canceled.",
      subjectPrefix: "Booking canceled",
    },
    reminder: {
      title: "Appointment Reminder",
      intro: "This is a friendly reminder about your upcoming appointment.",
      subjectPrefix: "Reminder",
    },
  };
  const h = headerByAction[action];

  const actionLinks =
    action === "canceled"
      ? ""
      : `
        <div style="margin-top: 24px; display:flex; gap:12px;">
          <a href="${args.rescheduleUrl}" style="display:inline-block;background:#0891b2;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">Reschedule</a>
          <a href="${args.cancelUrl}" style="display:inline-block;background:transparent;color:#475569;border:1px solid #cbd5e1;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:500;">Cancel</a>
        </div>
      `;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #f8fafc; padding: 24px;">
      <div style="background: white; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 24px 32px;">
          <h1 style="color: white; margin: 0 0 4px 0; font-size: 20px;">${h.title}</h1>
          <p style="color: #94a3b8; margin: 0; font-size: 14px;">${apptTypeName}</p>
        </div>
        <div style="padding: 32px;">
          <p style="color: #334155; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
            Hi ${contactName || "there"},
          </p>
          <p style="color: #334155; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
            ${h.intro}
          </p>
          <div style="background: #f1f5f9; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 14px; width: 110px;">When</td>
                <td style="padding: 6px 0; color: #0f172a; font-size: 14px; font-weight: 500;">${startLocal}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-size: 14px;">Duration</td>
                <td style="padding: 6px 0; color: #0f172a; font-size: 14px;">${durationMin} minutes</td>
              </tr>
              ${
                args.locationHtml
                  ? `<tr>
                      <td style="padding: 6px 0; color: #64748b; font-size: 14px; vertical-align: top;">Where</td>
                      <td style="padding: 6px 0; color: #0f172a; font-size: 14px;">${args.locationHtml}</td>
                    </tr>`
                  : ""
              }
            </table>
          </div>
          ${actionLinks}
        </div>
      </div>
      <p style="text-align: center; color: #94a3b8; font-size: 12px; margin-top: 16px;">
        ${args.orgName}
      </p>
    </div>
  `;

  return { subject: `${h.subjectPrefix}: ${apptTypeName} — ${startLocal}`, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const siteUrl = Deno.env.get("PUBLIC_SITE_URL") || "";

    const auth = req.headers.get("Authorization") || "";
    if (auth !== `Bearer ${serviceRoleKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { appointment_id, action } = (await req.json()) as {
      appointment_id?: string;
      action?: Action;
    };
    if (!appointment_id || !action) {
      return new Response(JSON.stringify({ error: "Missing appointment_id or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select(
        `
        id,
        org_id,
        start_at_utc,
        end_at_utc,
        visitor_timezone,
        google_meet_link,
        reschedule_token,
        cancel_token,
        answers,
        contact_id,
        calendar:calendars(id, name, slug),
        appointment_type:appointment_types(id, name, duration_minutes, location_type, location_value)
      `
      )
      .eq("id", appointment_id)
      .maybeSingle();

    if (apptErr || !appt) {
      console.error("booking-email: appointment not found", apptErr?.message);
      return new Response(JSON.stringify({ success: false, error: "Appointment not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const answers = (appt.answers || {}) as Record<string, string>;
    const recipientEmail = answers.email;
    const recipientName = answers.name || "";

    if (!recipientEmail) {
      return new Response(
        JSON.stringify({ success: false, reason: "no_recipient_email" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const creds = getResendEnvCreds();
    if (!creds) {
      console.warn("booking-email: Resend not configured for org", appt.org_id);
      return new Response(
        JSON.stringify({ success: false, reason: "mailgun_not_configured" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const [{ data: org }, defaults] = await Promise.all([
      supabase.from("organizations").select("name").eq("id", appt.org_id).maybeSingle(),
      loadOrgEmailDefaults(supabase, appt.org_id),
    ]);
    // The booker's brand (contacts.brand) decides the sender; the .ics organizer must match it.
    const brandSender = appt.contact_id
      ? (await resolveBrandSender(supabase, appt.org_id, { contactId: appt.contact_id as string })).row
      : null;

    const orgName = org?.name || "Orion";

    const tz = appt.visitor_timezone || "UTC";
    const startLocal = formatDateTime(appt.start_at_utc, tz);
    const apptType = appt.appointment_type as {
      name: string;
      duration_minutes: number;
      location_type: string | null;
      location_value: string | null;
    };
    const calendar = appt.calendar as { slug: string };

    const rescheduleUrl = `${siteUrl}/appointments/reschedule/${appt.reschedule_token}`;
    const cancelUrl = `${siteUrl}/appointments/cancel/${appt.cancel_token}`;
    const locationHtml = locationLine(
      apptType.location_type,
      apptType.location_value,
      appt.google_meet_link
    );

    const { subject, html } = buildBody({
      action,
      contactName: recipientName,
      apptTypeName: apptType.name,
      startLocal,
      durationMin: apptType.duration_minutes,
      locationHtml,
      rescheduleUrl,
      cancelUrl,
      orgName,
    });

    const attachments =
      action === "canceled"
        ? undefined
        : [
            {
              filename: "appointment.ics",
              contentType: "text/calendar; method=REQUEST",
              // Same builder and UID as the booking page's "Add to calendar", so importing
              // both updates one event instead of creating two.
              content: buildIcs({
                uid: `${appt.id}@orion.invalid`,
                method: "REQUEST",
                title: apptType.name,
                start: appt.start_at_utc,
                end: appt.end_at_utc,
                url: appt.google_meet_link,
                description: [
                  appt.google_meet_link ? `Join Google Meet: ${appt.google_meet_link}` : "",
                  `Reschedule: ${rescheduleUrl}`,
                  `Cancel: ${cancelUrl}`,
                ].filter(Boolean).join("\n"),
                // Same sender sendOrgEmail resolves below: the org default from address, else env.
                organizer: {
                  name: brandSender?.display_name ?? defaults.fromName ?? orgName,
                  email: brandSender?.email ?? defaults.fromEmail ?? creds.fromEmail,
                },
                attendee: { name: recipientName || null, email: recipientEmail },
              }),
            },
          ];

    // Org Defaults: default from address (display name falls back to the org name) + reply-to.
    // Transactional: the booker must get this, so no unsubscribe link / suppression block.
    const sendRes = await sendOrgEmail(supabase, appt.org_id, {
      fromName: defaults.fromName ?? orgName,
      contactId: (appt.contact_id as string | null) ?? null,
      to: recipientEmail,
      toName: recipientName || undefined,
      subject,
      html,
      attachments: toResendAttachments(attachments),
      transactional: true,
      categories: ["booking", action],
      defaults,
    });
    const fromEmail = sendRes.from ?? creds.fromEmail;

    if (!sendRes.ok) {
      console.error("booking-email: Resend error", sendRes.status, sendRes.error);
      return new Response(
        JSON.stringify({ success: false, status: sendRes.status, error: sendRes.error }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        action,
        to: recipientEmail,
        from: fromEmail,
        messageId: sendRes.messageId,
        calendar: calendar?.slug,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("booking-email error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
