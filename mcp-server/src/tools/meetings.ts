import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

/**
 * A5: MCP surface for /meetings' transcript search -- full-text search over
 * meeting_transcriptions.search_vector (generated tsvector column added by the
 * A5 migration, combining title/summary/transcript). Requests go through
 * PostgREST under the caller's own JWT, so the table's existing org-scoped RLS
 * policy (org_id = get_auth_user_org_id()) governs what comes back -- no
 * explicit org_id filter needed here, same pattern as
 * meeting_transcriptions_list in system.ts.
 */
export function registerMeetingsTools(server: McpServer): void {
  server.tool(
    'meeting_transcripts_search',
    'Full-text search across meeting transcripts (Google Meet/Zoom/Teams imports). Searches title/summary/transcript together via the generated search_vector column (websearch syntax: quotes, AND/OR, -exclude all supported). Returns matches newest first.',
    {
      q: z.string().describe('Search query, websearch syntax'),
      limit: z.number().optional().describe('Max rows, default 25'),
    },
    async ({ q, limit }) => {
      try {
        const trimmed = q.trim();
        if (!trimmed) return toolResult({ meetings: [] });

        // PostgREST full-text-search filter operator: col=wfts(config).query
        const searchFilter = `wfts(english).${trimmed}`;

        const meetings = await restGet('meeting_transcriptions', {
          select:
            'id,org_id,contact_id,meeting_source,meeting_title,meeting_date,duration_minutes,summary,recording_url',
          filters: { search_vector: searchFilter },
          order: 'meeting_date.desc',
          limit: limit || 25,
        });

        return toolResult({ meetings });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
