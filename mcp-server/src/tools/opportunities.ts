import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerOpportunitiesTools(server: McpServer): void {
  server.tool(
    'pipelines_list',
    'List sales pipelines with their stages',
    {},
    async () => {
      try {
        const data = await restGet('pipelines', {
          select: '*,stages:pipeline_stages(*)',
          order: 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipelines_create',
    'Create a sales pipeline',
    { name: z.string(), type: z.string().optional(), sort_order: z.number().optional() },
    async (params) => {
      try {
        const data = await restPost('pipelines', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipelines_update',
    'Update a pipeline',
    { id: z.string(), name: z.string().optional(), sort_order: z.number().optional() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('pipelines', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipelines_delete',
    'Delete a pipeline',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('pipelines', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_stages_list',
    'List stages for a pipeline',
    { pipeline_id: z.string() },
    async ({ pipeline_id }) => {
      try {
        const data = await restGet('pipeline_stages', {
          filters: { pipeline_id: `eq.${pipeline_id}` },
          order: 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_stages_create',
    'Create a pipeline stage',
    {
      pipeline_id: z.string(),
      name: z.string(),
      sort_order: z.number().optional(),
      probability: z.number().optional(),
      color: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('pipeline_stages', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_stages_update',
    'Update a pipeline stage',
    {
      id: z.string(),
      name: z.string().optional(),
      sort_order: z.number().optional(),
      probability: z.number().optional(),
      color: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('pipeline_stages', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_stages_delete',
    'Delete a pipeline stage',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('pipeline_stages', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunities_list',
    'List opportunities. Filter by pipeline, stage, status, owner.',
    {
      pipeline_id: z.string().optional(),
      stage_id: z.string().optional(),
      status: z.string().optional().describe('eq.open, eq.won, eq.lost'),
      owner_id: z.string().optional(),
      order: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.pipeline_id) filters['pipeline_id'] = `eq.${params.pipeline_id}`;
        if (params.stage_id) filters['stage_id'] = `eq.${params.stage_id}`;
        if (params.status) filters['status'] = params.status;
        if (params.owner_id) filters['owner_id'] = `eq.${params.owner_id}`;
        const data = await restGet('opportunities', {
          select: '*,contact:contacts(id,first_name,last_name,email,company),stage:pipeline_stages(id,name),owner:users!assigned_user_id(id,name)',
          filters,
          order: params.order || 'created_at.desc',
          limit: params.limit || 50,
          offset: params.offset,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunities_get',
    'Get opportunity detail with contact, stage, notes',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('opportunities', {
          select: '*,contact:contacts(*),stage:pipeline_stages(*),owner:users!assigned_user_id(id,name),notes:opportunity_notes(*)',
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
    'opportunities_create',
    'Create a new opportunity/deal',
    {
      name: z.string(),
      pipeline_id: z.string(),
      stage_id: z.string(),
      contact_id: z.string().optional(),
      value_amount: z.number().optional(),
      status: z.string().optional(),
      assigned_user_id: z.string().optional(),
      close_date: z.string().optional().describe('YYYY-MM-DD'),
      source: z.string().optional(),
      org_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('opportunities', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunities_update',
    'Update an opportunity (including stage move for kanban drag). For win/lose use opportunity_close.',
    {
      id: z.string(),
      name: z.string().optional(),
      stage_id: z.string().optional(),
      value_amount: z.number().optional(),
      status: z.string().optional(),
      assigned_user_id: z.string().optional(),
      close_date: z.string().optional().describe('YYYY-MM-DD'),
      lost_reason: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('opportunities', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunities_delete',
    'Delete an opportunity',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('opportunities', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunities_bulk_update_stage',
    'Bulk move opportunities to a new stage',
    {
      opportunity_ids: z.array(z.string()),
      stage_id: z.string(),
    },
    async ({ opportunity_ids, stage_id }) => {
      try {
        const data = await restPatch(
          'opportunities',
          { id: `in.(${opportunity_ids.join(',')})` },
          { stage_id },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_notes_list',
    'List notes for an opportunity',
    { opportunity_id: z.string(), limit: z.number().optional() },
    async ({ opportunity_id, limit }) => {
      try {
        const data = await restGet('opportunity_notes', {
          filters: { opportunity_id: `eq.${opportunity_id}` },
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
    'opportunity_notes_create',
    'Create a note on an opportunity',
    { opportunity_id: z.string(), content: z.string() },
    async (params) => {
      try {
        const data = await restPost('opportunity_notes', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'lost_reasons_list',
    'List predefined reasons for lost deals',
    {},
    async () => {
      try {
        const data = await restGet('lost_reasons', { order: 'name.asc' });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_close',
    'Close an opportunity as won or lost (sets closed_at, optional lost reason)',
    {
      id: z.string(),
      status: z.enum(['won', 'lost']),
      lost_reason_id: z.string().optional(),
      lost_reason: z.string().optional(),
    },
    async ({ id, status, lost_reason_id, lost_reason }) => {
      try {
        const body: Record<string, unknown> = {
          status,
          closed_at: new Date().toISOString(),
        };
        if (status === 'lost') {
          if (lost_reason_id) body.lost_reason_id = lost_reason_id;
          if (lost_reason) body.lost_reason = lost_reason;
        }
        const data = await restPatch('opportunities', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_reopen',
    'Reopen a closed opportunity (clears closed_at and lost reason)',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restPatch(
          'opportunities',
          { id: `eq.${id}` },
          { status: 'open', closed_at: null, lost_reason: null, lost_reason_id: null },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_stage_history_list',
    'List stage change history for an opportunity',
    { opportunity_id: z.string() },
    async ({ opportunity_id }) => {
      try {
        const data = await restGet('opportunity_stage_history', {
          filters: { opportunity_id: `eq.${opportunity_id}` },
          order: 'changed_at.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_timeline_list',
    'List timeline events for an opportunity',
    { opportunity_id: z.string(), limit: z.number().optional(), offset: z.number().optional() },
    async ({ opportunity_id, limit, offset }) => {
      try {
        const data = await restGet('opportunity_timeline_events', {
          select: '*,actor:users(id,name)',
          filters: { opportunity_id: `eq.${opportunity_id}` },
          order: 'created_at.desc',
          limit: limit || 50,
          offset,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_timeline_create',
    'Add a manual timeline event to an opportunity',
    {
      org_id: z.string(),
      opportunity_id: z.string(),
      contact_id: z.string().optional(),
      event_type: z.string(),
      summary: z.string(),
      payload: z.record(z.any()).optional(),
      actor_user_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('opportunity_timeline_events', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_set_custom_fields',
    'Upsert a custom field value on an opportunity. Provide exactly one value_* field matching the field type.',
    {
      org_id: z.string(),
      opportunity_id: z.string(),
      pipeline_custom_field_id: z.string(),
      value_text: z.string().optional(),
      value_number: z.number().optional(),
      value_date: z.string().optional(),
      value_boolean: z.boolean().optional(),
      value_json: z.any().optional(),
    },
    async (params) => {
      try {
        const data = await restPost(
          'opportunity_custom_field_values',
          params,
          'resolution=merge-duplicates,return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_custom_fields_list',
    'List custom field definitions for a pipeline',
    { pipeline_id: z.string() },
    async ({ pipeline_id }) => {
      try {
        const data = await restGet('pipeline_custom_fields', {
          filters: { pipeline_id: `eq.${pipeline_id}` },
          order: 'sort_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_custom_fields_create',
    'Create a custom field definition on a pipeline',
    {
      org_id: z.string().optional(),
      pipeline_id: z.string(),
      field_key: z.string(),
      field_type: z.string().describe('text, number, date, boolean, dropdown, multi_select'),
      name: z.string(),
      sort_order: z.number().optional(),
      options: z.any().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('pipeline_custom_fields', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_custom_fields_update',
    'Update a pipeline custom field definition',
    {
      id: z.string(),
      field_key: z.string().optional(),
      field_type: z.string().optional(),
      name: z.string().optional(),
      sort_order: z.number().optional(),
      options: z.any().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('pipeline_custom_fields', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'pipeline_custom_fields_delete',
    'Delete a pipeline custom field definition',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('pipeline_custom_fields', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'lost_reasons_create',
    'Create a lost reason',
    { org_id: z.string(), name: z.string() },
    async (params) => {
      try {
        const data = await restPost('lost_reasons', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'lost_reasons_update',
    'Update a lost reason',
    { id: z.string(), name: z.string() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('lost_reasons', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'lost_reasons_delete',
    'Delete a lost reason',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('lost_reasons', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'opportunity_stats',
    'List opportunity status + value rows for aggregation. Filter by pipeline_id and/or status. Aggregate client-side (counts, sums, conversion).',
    {
      pipeline_id: z.string().optional(),
      status: z.string().optional().describe('eq.open, eq.won, eq.lost'),
    },
    async ({ pipeline_id, status }) => {
      try {
        const filters: Record<string, string> = {};
        if (pipeline_id) filters['pipeline_id'] = `eq.${pipeline_id}`;
        if (status) filters['status'] = status;
        const data = await restGet('opportunities', {
          select: 'id,status,value_amount,pipeline_id,stage_id',
          filters,
          limit: 10000,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
