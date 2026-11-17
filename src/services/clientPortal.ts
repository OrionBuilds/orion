/**
 * Client Portal service — thin wrapper around the `client-portal-auth`
 * edge function + localStorage session management.
 */

import { fetchEdge } from '../lib/edgeFunction';
import { logError } from '../lib/errors';

const SLUG = 'client-portal-auth';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Types ───────────────────────────────────────────────────────

export interface SendCodeResult {
  success: boolean;
  maskedEmail?: string;
  expiresAt?: string;
  rateLimited?: boolean;
  error?: string;
}

export interface VerifyCodeResult {
  success: boolean;
  /** Set by the edge function when the OTP code has expired. */
  expired?: boolean;
  sessionToken?: string;
  sessionId?: string;
  expiresAt?: string;
  attemptsRemaining?: number;
  maxAttemptsExceeded?: boolean;
  error?: string;
}

export interface ValidateSessionResult {
  valid: boolean;
  sessionId?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  orgId?: string;
  orgName?: string;
  supportEmail?: string;
  lastOtpVerifiedAt?: string;
  expiresAt?: string;
}

export interface ClientPortalProject {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  start_date: string | null;
  target_end_date: string | null;
  progress_percent: number;
  budget_amount: number;
  currency: string;
  stage_id: string;
  pipeline_id: string;
  contact_id: string;
  created_at: string;
  updated_at: string;
  stage?: { id: string; name: string; sort_order: number; color: string | null };
}

export interface ClientPortalProjectDetail extends ClientPortalProject {
  pipeline?: { id: string; name: string };
  contact?: { id: string; first_name: string; last_name: string; email: string };
  orgName?: string;
  supportEmail?: string;
}

export interface PortalSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  rememberDevice: boolean;
  deviceLabel: string;
  isCurrent: boolean;
}

// ─── API calls ───────────────────────────────────────────────────

/** Call the portal-auth edge function with the anon key (no Supabase session needed). */
async function callPortalAuth(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${SLUG}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch (err) {
    logError('clientPortal.callPortalAuth', err);
  }

  // Expected failures (rate limits, wrong OTP, ...) come back as a structured
  // `{ success: false, ... }` body on a 4xx and are handled by the callers.
  if (!parsed) {
    throw new Error(
      `Portal request "${body.action}" failed (${res.status})${raw ? `: ${raw.slice(0, 200)}` : ''}`
    );
  }
  if (!res.ok && parsed.success === undefined && parsed.valid === undefined) {
    throw new Error(
      typeof parsed.error === 'string'
        ? parsed.error
        : `Portal request "${body.action}" failed (${res.status})`
    );
  }

  return parsed;
}

export async function sendLoginCode(
  email: string,
  inviteToken?: string
): Promise<SendCodeResult> {
  const result = await callPortalAuth({
    action: 'send-code',
    email,
    inviteToken,
  });
  return result as unknown as SendCodeResult;
}

export async function verifyLoginCode(
  email: string,
  code: string,
  rememberDevice: boolean,
  inviteToken?: string,
  sessionToken?: string
): Promise<VerifyCodeResult> {
  // sessionToken puts verify-code in STEP-UP mode: the fresh OTP stamps the
  // existing session's last_otp_verified_at instead of minting a new session.
  // The server only moves that timestamp here — mark-step-up-verified is a
  // read-only no-op — so step-up flows must pass the current session token or
  // sensitive actions will still be refused with step_up_required.
  const result = await callPortalAuth({
    action: 'verify-code',
    email,
    code,
    rememberDevice,
    inviteToken,
    ...(sessionToken ? { sessionToken } : {}),
  });
  return result as unknown as VerifyCodeResult;
}

export async function validateSession(
  sessionToken: string
): Promise<ValidateSessionResult> {
  const result = await callPortalAuth({
    action: 'validate-session',
    sessionToken,
  });
  return result as unknown as ValidateSessionResult;
}

export async function fetchMyProjects(
  sessionToken: string
): Promise<ClientPortalProject[]> {
  const result = await callPortalAuth({
    action: 'fetch-projects',
    sessionToken,
  });
  if (result.error) throw new Error(String(result.error));
  return (result as { projects?: ClientPortalProject[] }).projects ?? [];
}

export async function fetchProject(
  sessionToken: string,
  projectId: string
): Promise<ClientPortalProjectDetail | null> {
  const result = await callPortalAuth({
    action: 'fetch-project',
    sessionToken,
    projectId,
  });
  if (result.error) throw new Error(String(result.error));
  if (!(result as { success?: boolean }).success) return null;
  const data = result as {
    project: ClientPortalProjectDetail;
    orgName: string;
    supportEmail: string;
  };
  return { ...data.project, orgName: data.orgName, supportEmail: data.supportEmail };
}

export interface PortalBridgeContext {
  project: Record<string, unknown>;
  organization: { id: string; name: string; email: string | null; phone: string | null; website: string | null } | null;
  accountId: string | null;
  contactId: string;
  orgName: string;
  supportEmail: string;
}

/** Everything ClientPortalProjectBridge needs, in one session-authorized call.
 *  Replaces the bridge's former direct anon-table reads, which all broke when
 *  F-41 dropped the anon policies — the project pages showed "Project not
 *  found" for every client from 2026-07-30 until this. */
export async function fetchProjectBridgeContext(
  sessionToken: string,
  projectId: string
): Promise<PortalBridgeContext | null> {
  const result = await callPortalAuth({
    action: 'fetch-project',
    sessionToken,
    projectId,
  });
  if (result.error) throw new Error(String(result.error));
  if (!(result as { success?: boolean }).success) return null;
  return result as unknown as PortalBridgeContext;
}

export async function markStepUpVerified(sessionToken: string): Promise<void> {
  // Server-side this is now a read-only no-op: the last_otp_verified_at stamp
  // moves ONLY when verify-code succeeds (pass the session token to
  // verifyLoginCode for step-up). Kept so existing callers don't break.
  await callPortalAuth({ action: 'mark-step-up-verified', sessionToken });
}

// ─── Portal data (session-validated, service-role edge reads/writes) ───────
// These replace the V1 portal's direct anon table access. The session token comes from
// localStorage; the edge function authorizes each row against the session's contact.

export async function portalData<T>(action: string, extra: Record<string, unknown>): Promise<T> {
  const sessionToken = getStoredSession();
  if (!sessionToken) throw new Error('Not signed in to the portal');
  const result = await callPortalAuth({ action, sessionToken, ...extra });
  if (result.error) throw new Error(String(result.error));
  return result.data as T;
}

export const portalListChangeRequests = (projectId: string, statusFilter?: string[]) =>
  portalData<unknown[]>('list-change-requests', { projectId, statusFilter });
export const portalGetChangeRequest = (requestId: string) =>
  portalData<unknown>('get-change-request', { requestId });
export const portalListChangeRequestComments = (changeRequestId: string) =>
  portalData<unknown[]>('list-change-request-comments', { changeRequestId });
export const portalListSupportTickets = (projectId: string) =>
  portalData<unknown[]>('list-support-tickets', { projectId });
export const portalGetSupportTicket = (ticketId: string) =>
  portalData<unknown>('get-support-ticket', { ticketId });
export const portalListTicketComments = (ticketId: string) =>
  portalData<unknown[]>('list-ticket-comments', { ticketId });
/** Structured plain-English body of a narrative (milestone) entry — sections.v1. */
export interface PortalUpdateSections {
  /** What took place — why this work happened / what was asked. */
  context: string | null;
  /** What we did. */
  changes: string | null;
  /** How it affects your software — what you'll notice, by screen/feature. */
  impact: string | null;
  /** What's live now. */
  live_now: string | null;
  /** What to check — short things worth trying. */
  check: string[];
}
export interface PortalActivityEvent {
  id: string;
  event_type: string;
  summary: string;
  created_at: string;
  /** Curated headline for narrative (milestone) entries; falls back to summary. */
  title?: string | null;
  /** Expandable "what & why" body for narrative entries (plain text; legacy or concatenated sections). */
  detail?: string | null;
  /** Labelled sections; when present the portal renders these instead of `detail`. */
  sections?: PortalUpdateSections | null;
  /** True when the change is live on the client's site/app. */
  is_live?: boolean | null;
  kind?: string | null;
}
/** Client-safe project timeline (whitelisted event types, filtered server-side). */
export const portalListProjectActivity = (projectId: string, limit = 50) =>
  portalData<PortalActivityEvent[]>('list-project-activity', { projectId, limit });
export const portalApproveChangeRequest = (requestId: string) =>
  portalData<void>('approve-change-request', { requestId });
export const portalRejectChangeRequest = (requestId: string, reason?: string) =>
  portalData<void>('reject-change-request', { requestId, reason });
export const portalAddChangeRequestComment = (changeRequestId: string, body: string, authorName: string) =>
  portalData<void>('add-change-request-comment', { changeRequestId, body, authorName });

/** A build/release awaiting the client's go-live sign-off (tied to a PR). */
export interface PortalReleaseApproval {
  id: string;
  project_id: string;
  title: string;
  changelog: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'merged';
  created_at: string;
  client_decided_at: string | null;
}
export const portalListReleaseApprovals = () =>
  portalData<PortalReleaseApproval[]>('list-release-approvals', {});
/** Approve/reject a build. Throws with 'step_up_required' when a recent OTP is needed. */
export const portalDecideReleaseApproval = (approvalId: string, decision: 'approve' | 'reject') =>
  portalData<void>('decide-release-approval', { approvalId, decision });
/** Delivered work awaiting the client's feedback ("Ready for your review"). */
export interface PortalClientReviewComment {
  id: string;
  author_type: 'client' | 'agent' | 'staff';
  author_name: string | null;
  body: string;
  created_at: string;
}
export interface PortalClientReview {
  id: string;
  project_id: string;
  title: string;
  summary: string;
  preview_url: string | null;
  round: number;
  status: 'pending' | 'accepted' | 'changes_requested';
  client_comment: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  comments: PortalClientReviewComment[];
}
export const portalListClientReviews = (projectId?: string) =>
  portalData<PortalClientReview[]>('list-client-reviews', projectId ? { projectId } : {});
/** Approve, or request changes (a comment is required for request_changes). */
export const portalDecideClientReview = (reviewId: string, decision: 'approve' | 'request_changes', comment?: string) =>
  portalData<{ status: string }>('decide-client-review', { reviewId, decision, comment });
export const portalAddClientReviewComment = (reviewId: string, body: string) =>
  portalData<{ id: string }>('add-client-review-comment', { reviewId, body });
export const portalAddTicketComment = (ticketId: string, body: string, authorName: string) =>
  portalData<void>('add-ticket-comment', { ticketId, body, authorName });

// ─── Portal submissions (session-validated, service-role edge writes) ──────
// These replace the modals' direct anon-key inserts, which depended on the
// WITH CHECK (true) anon INSERT policies (dropped in 20260824222000). Client
// identity (name/email/phone) is resolved server-side from the session's
// contact, so the body carries only the form content.

export const portalCreateChangeRequest = (input: {
  projectId: string;
  title: string;
  requestType: string;
  priority: string;
  description: string;
  requestedDueDate?: string;
}) => portalData<{ id: string } & Record<string, unknown>>('create-change-request', { ...input });

export const portalCreateSupportTicket = (input: {
  projectId: string;
  title: string;
  serviceCategory: string;
  requestType: string;
  priority: string;
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  affectedArea?: string;
  affectedFeature?: string;
  affectedIntegration?: string;
  environment?: string;
  browserInfo?: string;
  errorMessages?: string;
  attachments?: { name: string; url: string; size: number; type: string }[];
  businessImpact?: string;
  impactDescription?: string;
  usersAffectedCount?: number;
  workaroundAvailable?: boolean;
  preferredContactMethod?: string;
  availabilityWindow?: string;
  expectedResolutionDate?: string;
}) => portalData<{ id: string } & Record<string, unknown>>('create-support-ticket', { ...input });

export async function portalUploadTicketAttachment(
  projectId: string,
  file: File
): Promise<{ name: string; url: string; size: number; type: string }> {
  // The edge function enforces the real limits (10MB, extension passlist);
  // base64 via JSON is fine at that size.
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return portalData<{ name: string; url: string; size: number; type: string }>('upload-ticket-attachment', {
    projectId,
    fileName: file.name,
    contentType: file.type,
    dataBase64,
  });
}

export async function listSessions(sessionToken: string): Promise<PortalSession[]> {
  const result = await callPortalAuth({ action: 'list-sessions', sessionToken });
  if (result.error) throw new Error(String(result.error));
  return (result as { sessions?: PortalSession[] }).sessions ?? [];
}

export async function logoutSession(sessionToken: string): Promise<void> {
  await callPortalAuth({ action: 'logout', sessionToken });
}

export async function sendPortalInvite(
  projectId: string,
  contactId?: string
): Promise<{ success: boolean; skippedReason?: string }> {
  const response = await fetchEdge(SLUG, {
    body: { action: 'send-invite', projectId, ...(contactId ? { contactId } : {}) },
    method: 'POST',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    throw new Error(result?.error || `Failed to send portal invite (${response.status})`);
  }
  return result;
}

// ─── localStorage helpers ────────────────────────────────────────

const SESSION_KEY = 'client_portal_session_token';
const ORG_KEY = 'client_portal_org_id';

export function getStoredSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function storeSession(token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch (err) {
    logError('clientPortal.storeSession', err);
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ORG_KEY);
  } catch (err) {
    logError('clientPortal.clearSession', err);
  }
}

export function getStoredOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function storeOrgId(orgId: string): void {
  try {
    localStorage.setItem(ORG_KEY, orgId);
  } catch (err) {
    logError('clientPortal.storeOrgId', err);
  }
}
