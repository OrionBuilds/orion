import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction } from '../helpers/edge-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerGovernmentTools(server: McpServer): void {
  server.tool(
    'gov_opportunities_search',
    'Search SAM.gov government contract opportunities',
    {
      keywords: z.string().optional(),
      naicsCode: z.string().optional(),
      pscCode: z.string().optional(),
      setAsideType: z.string().optional(),
      state: z.string().optional(),
      agencyName: z.string().optional(),
      procurementType: z.string().optional(),
      postedFrom: z.string().optional(),
      postedTo: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const data = await callEdgeFunction('sam-gov-api', { action: 'search-opportunities', ...params });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_opportunity_get',
    'Get a single SAM.gov opportunity by notice ID',
    { noticeId: z.string() },
    async ({ noticeId }) => {
      try {
        const data = await callEdgeFunction('sam-gov-api', { action: 'get-opportunity', noticeId });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_opportunity_description',
    'Fetch the full description text for a SAM.gov opportunity',
    { noticeId: z.string() },
    async ({ noticeId }) => {
      try {
        const data = await callEdgeFunction('sam-gov-api', { action: 'get-description', noticeId });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_psc_search',
    'Search SAM.gov Product Service Codes (PSC)',
    {
      query: z.string(),
      active: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ query, active, limit }) => {
      try {
        const data = await callEdgeFunction('sam-gov-api', { action: 'search-psc', query, active, limit });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_opportunity_import',
    'Import a SAM.gov opportunity into the Government CRM pipeline',
    {
      samData: z.record(z.unknown()),
      contactId: z.string().optional(),
    },
    async ({ samData, contactId }) => {
      try {
        const data = await callEdgeFunction('sam-gov-api', { action: 'import-opportunity', samData, contactId });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_saved_searches_list',
    'List saved SAM.gov searches for an organization',
    { org_id: z.string() },
    async ({ org_id }) => {
      try {
        const data = await restGet('gov_saved_searches', {
          filters: { org_id: `eq.${org_id}` },
          order: 'created_at.desc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_saved_searches_create',
    'Create a saved SAM.gov search with optional alerting',
    {
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      search_criteria: z.record(z.unknown()),
      alert_enabled: z.boolean().optional(),
      alert_frequency: z.enum(['daily', 'weekly']).optional(),
    },
    async (params) => {
      try {
        const data = await restPost('gov_saved_searches', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_saved_searches_update',
    'Update a saved SAM.gov search',
    {
      id: z.string(),
      name: z.string().optional(),
      search_criteria: z.record(z.unknown()).optional(),
      alert_enabled: z.boolean().optional(),
      alert_frequency: z.enum(['daily', 'weekly']).optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('gov_saved_searches', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_saved_searches_delete',
    'Delete a saved SAM.gov search',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('gov_saved_searches', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'gov_search_history_list',
    'List SAM.gov search history for an organization',
    {
      org_id: z.string(),
      limit: z.number().optional(),
    },
    async ({ org_id, limit }) => {
      try {
        const data = await restGet('gov_search_history', {
          filters: { org_id: `eq.${org_id}` },
          order: 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
