import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete, restRpc } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerFormsTools(server: McpServer): void {
  server.tool(
    'forms_list',
    'List forms',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('forms', { order: 'name.asc', limit: limit || 50 });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'forms_get',
    'Get form detail with submission count',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('forms', {
          select: '*,submissions:form_submissions(count)',
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'forms_create',
    'Create a form with field definitions',
    {
      name: z.string(),
      description: z.string().optional(),
      fields: z.array(z.record(z.unknown())).optional(),
      settings: z.record(z.unknown()).optional(),
      is_active: z.boolean().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('forms', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'forms_update',
    'Update a form',
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      fields: z.array(z.record(z.unknown())).optional(),
      settings: z.record(z.unknown()).optional(),
      is_active: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('forms', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'forms_delete',
    'Delete a form',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('forms', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'form_submissions_list',
    'List submissions for a form',
    { form_id: z.string(), limit: z.number().optional() },
    async ({ form_id, limit }) => {
      try {
        const data = await restGet('form_submissions', {
          filters: { form_id: `eq.${form_id}` },
          order: 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'form_submissions_get',
    'Get a specific form submission',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('form_submissions', {
          filters: { id: `eq.${id}` },
          accept: 'application/vnd.pgrst.object+json',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'form_submissions_delete',
    'Delete a form submission',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('form_submissions', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'surveys_list',
    'List surveys',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('surveys', { order: 'name.asc', limit: limit || 50 });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'surveys_create',
    'Create a survey',
    {
      name: z.string(),
      description: z.string().optional(),
      questions: z.array(z.record(z.unknown())).optional(),
      settings: z.record(z.unknown()).optional(),
      is_active: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('surveys', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'surveys_update',
    'Update a survey',
    { id: z.string(), name: z.string().optional(), is_active: z.boolean().optional() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('surveys', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'surveys_delete',
    'Delete a survey',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('surveys', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'form_submit_public',
    'Public form submission endpoint (no auth required)',
    {
      form_id: z.string(),
      data: z.record(z.unknown()),
      metadata: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const result = await callEdgeFunction('form-submit', params);
        return toolResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'survey_submit_public',
    'Public survey submission endpoint',
    {
      survey_id: z.string(),
      responses: z.array(z.record(z.unknown())),
      respondent: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const result = await callEdgeFunction('survey-submit', params);
        return toolResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'scoring_api',
    'Lead/entity scoring. Actions: list-models, create-model, list-rules, adjust-score, get-entity-scores',
    {
      action: z.string(),
      payload: z.record(z.unknown()).optional(),
    },
    async ({ action, payload }) => {
      try {
        const data = await callEdgeFunction('scoring-api', { action, ...payload });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- scorecard drip: consented readiness-scorecard leads due for Clara's SMS follow-up ------
  server.tool(
    'scorecard_drip_candidates',
    'Readiness-scorecard leads eligible for Clara SMS follow-up: consented (sms_consent custom field), phone on file, not on DNC, no inbound reply / booking / exit tag since their latest scorecard. Each row carries scorecard_completed_at (drip clock), tokens (first_name, vertical, framework_short, score, band_title, weakest, pain, proof, role, trigger, book_short_url, outline_url...), steps_sent (SMS steps already sent, 1-4), e3_clicked (Sprint-outline link clicked), last_step_at. Org-scoped to the caller. CLARA computes due steps: S1 >= 28h, S2 >= 72h, S3 >= 144h (skip if e3_clicked), S4 >= 240h.',
    {
      limit: z.number().int().min(1).max(1000).optional().describe('Max leads to return (default 200)'),
    },
    async ({ limit }) => {
      try {
        return toolResult(await restRpc('scorecard_sms_drip_candidates', { p_limit: limit ?? 200 }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- scorecard drip: CLARA's bookkeeping write path (messages, timeline, tags) ---------------
  server.tool(
    'scorecard_drip_event',
    'Record a scorecard follow-up event for a contact. kind=sms_out (Clara sent a text: body, meta {step, sid, from_number, delivery_status}), sms_in (lead replied by text; logs an inbound message so the email workflow stops, tags conversation), email_in (lead replied by email; same), shadow (dry-run record: meta {step}), tag (meta {tag} e.g. closed-no, later, outline, booked-consult), note (meta {event_type, ...}). Org-scoped to the caller. Returns { ok, message_id?, conversation_id?, tag_id? }.',
    {
      contact_id: z.string().describe('Contact UUID'),
      kind: z.enum(['sms_out', 'sms_in', 'email_in', 'shadow', 'tag', 'note']),
      body: z.string().optional().describe('Message text (sms_out/sms_in/email_in/shadow/note)'),
      meta: z.record(z.unknown()).optional().describe('step, sid, from_number, delivery_status, subject, tag, event_type…'),
    },
    async ({ contact_id, kind, body, meta }) => {
      try {
        return toolResult(await restRpc('scorecard_drip_event', { p_contact_id: contact_id, p_kind: kind, p_body: body ?? null, p_meta: meta ?? {} }));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // --- scorecard lead lookup: who is Clara talking to (phone or email -> contact + scorecard context)
  server.tool(
    'scorecard_lead_lookup',
    'Resolve a phone number or email to an OS contact with readiness-scorecard context: name, company, tags, custom fields (industry, readiness_score, readiness_band, sms_consent), latest scorecard (score, band, area_scores, weakest_area, completed_at), drip_tokens, sms_steps_sent, emails_sent (drip_step), inbound_messages count, open opportunity + stage, next appointment, is_scorecard_lead. Returns null when no contact matches. Org-scoped to the caller.',
    {
      phone: z.string().optional().describe('E.164 or any format; matched on the last 10 digits'),
      email: z.string().optional(),
    },
    async ({ phone, email }) => {
      try {
        return toolResult(await restRpc('scorecard_lead_lookup', { p_phone: phone ?? null, p_email: email ?? null }));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
