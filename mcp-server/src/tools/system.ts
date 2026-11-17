import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction, callEdgeRoute } from '../helpers/edge-client.js';
import { calendarSyncRoute, providerParam, resolveWorkspaceProvider } from '../helpers/workspace-provider.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { whoami } from '../helpers/whoami.js';

export function registerSystemTools(server: McpServer): void {
  server.tool(
    'notifications_list',
    'List in-app notifications for a user',
    {
      user_id: z.string(),
      is_read: z.boolean().optional(),
      limit: z.number().optional(),
    },
    async ({ user_id, is_read, limit }) => {
      try {
        const filters: Record<string, string> = { user_id: `eq.${user_id}` };
        if (is_read !== undefined) filters['is_read'] = `eq.${is_read}`;
        const data = await restGet('notifications', {
          filters,
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
    'notifications_create',
    'Create an in-app notification for a user (e.g. Clara flagging an email that needs their attention — type "email.flagged" surfaces in the dashboard Follow-ups tab)',
    {
      user_id: z.string().describe('The OS user this notification is for'),
      type: z.string().describe('Notification type, e.g. "email.flagged", "system"'),
      title: z.string(),
      body: z.string().optional(),
      link: z.string().optional().describe('URL opened when the user clicks it'),
      metadata: z.record(z.unknown()).optional(),
    },
    async ({ user_id, type, title, body, link, metadata }) => {
      try {
        const data = await restPost('notifications', {
          user_id,
          type,
          title,
          body: body ?? null,
          link: link ?? null,
          metadata: metadata ?? {},
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'notifications_mark_read',
    'Mark a notification as read',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'notifications',
          { id: `eq.${id}` },
          { is_read: true },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'notifications_mark_all_read',
    'Mark all unread notifications as read for a user',
    { user_id: z.string() },
    async ({ user_id }) => {
      try {
        const data = await restPatch(
          'notifications',
          { user_id: `eq.${user_id}`, is_read: 'eq.false' },
          { is_read: true },
        );
        return toolResult(data ?? { success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'notifications_delete',
    'Delete a notification',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('notifications', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'user_preferences_get',
    'Get user preferences',
    { user_id: z.string() },
    async ({ user_id }) => {
      try {
        const data = await restGet('user_preferences', {
          filters: { user_id: `eq.${user_id}` },
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'user_preferences_update',
    'Update user preferences',
    {
      user_id: z.string(),
      theme: z.string().optional(),
      timezone: z.string().optional(),
      locale: z.string().optional(),
      preferences: z.record(z.unknown()).optional(),
    },
    async ({ user_id, ...body }) => {
      try {
        const data = await restPatch(
          'user_preferences',
          { user_id: `eq.${user_id}` },
          body,
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'user_notification_preferences_get',
    'Get per-user notification channel preferences',
    { user_id: z.string() },
    async ({ user_id }) => {
      try {
        const data = await restGet('user_notification_preferences', {
          filters: { user_id: `eq.${user_id}` },
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'user_connected_accounts_list',
    'List external accounts connected by a user',
    { user_id: z.string() },
    async ({ user_id }) => {
      try {
        const data = await restGet('user_connected_accounts', {
          filters: { user_id: `eq.${user_id}` },
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_values_list',
    'List organization-wide custom values with categories',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('custom_values', {
          select: '*,category:custom_value_categories(id,name)',
          order: 'name.asc',
          limit: limit || 200,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_values_create',
    'Create a custom value',
    {
      key: z.string(),
      value: z.string(),
      category_id: z.string().optional(),
      sort_order: z.number().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('custom_values', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_values_update',
    'Update a custom value',
    {
      id: z.string(),
      key: z.string().optional(),
      value: z.string().optional(),
      sort_order: z.number().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('custom_values', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_values_delete',
    'Delete a custom value',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('custom_values', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_value_categories_list',
    'List custom value categories',
    {},
    async () => {
      try {
        const data = await restGet('custom_value_categories', { order: 'name.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── Assistant / Clara tools ────────────────────────────────────────────────
  // B6 (Clara decommission): the in-app assistant UI is retired, but these MCP tools stay
  // DELIBERATELY registered. Rationale:
  //   - assistant_meeting_processor backs the /meetings "Send to Memory" flow and OS handlers.
  //   - clara_memories_list / clara_memory_decay serve the external CLARA app's cold archive
  //     (clara_memories table + weekly clara-memory-decay cron) — must keep working.
  //   - assistant_chat/voice/tts/stt_* and assistant_threads_* hit edge functions and tables that
  //     remain deployed (soft-decommission, zero data loss); exposing them via MCP lets CLARA and
  //     agents read historical threads/memories even though no UI reaches them anymore.
  server.tool(
    'assistant_threads_list',
    'List Clara AI assistant conversation threads',
    { user_id: z.string(), limit: z.number().optional() },
    async ({ user_id, limit }) => {
      try {
        const data = await restGet('assistant_threads', {
          filters: { user_id: `eq.${user_id}` },
          order: 'updated_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_threads_get',
    'Get assistant thread with messages',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('assistant_threads', {
          select: '*,messages:assistant_messages(*)',
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
    'assistant_threads_create',
    'Create a new assistant thread',
    {
      title: z.string().optional(),
      user_id: z.string().optional(),
    },
    async (params) => {
      try {
        // org_id and user_id are NOT NULL: default both from the caller (the insert always 400'd before).
        const who = await whoami();
        const data = await restPost('assistant_threads', {
          ...(params.title ? { title: params.title } : {}),
          user_id: params.user_id ?? who.user_id,
          org_id: who.organization_id,
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_threads_delete',
    'Delete an assistant thread',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('assistant_threads', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'clara_memories_list',
    'List Clara AI memory entries',
    { user_id: z.string().optional(), limit: z.number().optional() },
    async ({ user_id, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (user_id) filters['user_id'] = `eq.${user_id}`;
        const data = await restGet('clara_memories', {
          filters,
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
    'meeting_transcriptions_list',
    'List meeting transcription records',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('meeting_transcriptions', {
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
    'assistant_chat',
    'Send a message to the Clara AI assistant',
    {
      thread_id: z.string().optional(),
      message: z.string(),
      context: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-chat', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_voice',
    'Voice interaction with Clara (speech-to-text input)',
    {
      thread_id: z.string().optional(),
      audio_base64: z.string(),
      format: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-voice', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_tts',
    'Text-to-speech conversion for Clara responses',
    {
      text: z.string(),
      voice: z.string().optional(),
      speed: z.number().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-tts', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_stt_wake',
    'Wake word detection for hands-free voice activation',
    {
      audio_base64: z.string(),
      format: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-stt-wake', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_stt_final',
    'Final speech-to-text processing for complete utterances',
    {
      audio_base64: z.string(),
      format: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-stt-final', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'clara_memory_decay',
    'Run Clara memory decay to manage context relevance',
    {},
    async () => {
      try {
        const data = await callEdgeFunction('clara-memory-decay', {});
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'assistant_meeting_processor',
    'Process meeting recordings to generate transcriptions and summaries',
    {
      meeting_id: z.string(),
      audio_url: z.string().optional(),
      generate_summary: z.boolean().optional(),
      extract_action_items: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('assistant-meeting-processor', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // google-calendar-sync-runner / microsoft-calendar-sync are cron targets (X-Cron-Secret or
  // service role) and 401 for agent JWTs. Agents run the user-facing pull for their OWN
  // connection instead: google-calendar-sync 'sync-incremental' or microsoft-calendar 'sync'.
  server.tool(
    'google_calendar_sync_runner',
    "Run a calendar sync for the caller's own connection (Google: incremental pull; Outlook: window pull). The org-wide scheduled runners are cron-only.",
    { provider: providerParam },
    async ({ provider }) => {
      try {
        const p = await resolveWorkspaceProvider(provider);
        const data = await callEdgeRoute(calendarSyncRoute(p, true));
        return toolResult({ provider: p, ...(typeof data === 'object' && data !== null ? data : { result: data }) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'meet_reprocess',
    'Reprocess ONE Google Meet session (fetch transcript/recording/Gemini notes) by google_meet_sessions id, bypassing the 90-day backfill window; the session must belong to the caller\'s org. Draining the pending batch is cron-only (meet-processing-cron). Teams meetings are processed automatically by teams-meeting-processor; transcripts can also be imported manually in the Meetings page. Set artifacts_only=true to fetch and store artifacts WITHOUT creating tasks or publishing follow-up events.',
    {
      session_id: z.string().optional().describe('A google_meet_sessions id to force-process (required for agent callers)'),
      artifacts_only: z.boolean().optional().describe('Skip task creation and the meeting_processed event'),
    },
    async (params) => {
      try {
        if (!params.session_id) {
          return toolError(new Error(
            'session_id is required: meet-processing-job only accepts a user/agent token for a single own-org session; the pending-batch drain runs on the meet-processing-cron schedule.',
          ));
        }
        const data = await callEdgeFunction('meet-processing-job', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'dashboard_insights',
    'Get live dashboard finance/sales KPIs with AI narrative insights. Pass force=true to bypass the 24h insight cache.',
    {
      force: z.boolean().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('dashboard-insights', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
  // --- org_settings_get: org-level switches agents must honour ------------------------------
  server.tool(
    'org_settings_get',
    "Read my organization's agent-relevant settings: agent_client_comms_enabled (may agents contact clients at all; default false - when false, send nothing to clients), default_workspace_provider, business_timezone.",
    {},
    async () => {
      try {
        const who = await whoami();
        const rows = (await restGet('organizations', {
          select: 'id,name,agent_client_comms_enabled,default_workspace_provider,business_timezone',
          filters: { id: `eq.${who.organization_id}` },
          limit: 1,
        })) as Array<Record<string, unknown>>;
        const o = rows?.[0];
        if (!o) throw new Error('organization not readable');
        return toolResult({
          organization_id: o.id,
          name: o.name,
          agent_client_comms_enabled: o.agent_client_comms_enabled === true,
          default_workspace_provider: o.default_workspace_provider ?? null,
          business_timezone: o.business_timezone ?? null,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
