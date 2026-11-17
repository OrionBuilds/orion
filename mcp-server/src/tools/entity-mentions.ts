import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restDelete } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { parseMentions, buildMentionSnippet } from '../utils/mentionTokens.js';

const SOURCE_TYPES = [
  'team_message',
  'contact_note',
  'project_note',
  'opportunity_note',
  'document',
  'contact_task',
  'project_task',
  'conversation_message',
] as const;

const TARGET_TYPES = ['contact', 'opportunity', 'project', 'proposal', 'document', 'user'] as const;

export function registerEntityMentionsTools(server: McpServer): void {
  server.tool(
    'entity_mentions_list',
    'List @entity mention records (the raw entity_mentions rows), optionally filtered by source or target. Use entity_backlinks_get instead when you just want "what mentions this entity".',
    {
      source_type: z.enum(SOURCE_TYPES).optional(),
      source_id: z.string().optional(),
      target_type: z.enum(TARGET_TYPES).optional(),
      target_id: z.string().optional(),
      limit: z.number().optional().describe('Max rows, default 50'),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.source_type) filters['source_type'] = `eq.${params.source_type}`;
        if (params.source_id) filters['source_id'] = `eq.${params.source_id}`;
        if (params.target_type) filters['target_type'] = `eq.${params.target_type}`;
        if (params.target_id) filters['target_id'] = `eq.${params.target_id}`;
        const data = await restGet('entity_mentions', {
          select: '*',
          filters,
          order: 'created_at.desc',
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
    'entity_backlinks_get',
    'Get everything that @mentions a given entity (contact/opportunity/project/proposal/document/user) — the ReferencesPanel data, newest first.',
    {
      target_type: z.enum(TARGET_TYPES),
      target_id: z.string(),
      limit: z.number().optional().describe('Max rows, default 50'),
    },
    async ({ target_type, target_id, limit }) => {
      try {
        const data = await restGet('entity_mentions', {
          select: '*,created_by_user:users!entity_mentions_created_by_fkey(id,name,avatar_url)',
          filters: {
            target_type: `eq.${target_type}`,
            target_id: `eq.${target_id}`,
          },
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
    'entity_mentions_sync',
    'Parse @[Display Name](type:id) tokens out of agent-written text and index them as backlinks (diff-based: adds new mentions, removes ones no longer present). Call this after an agent creates/edits a team message, note, or task body containing mentions — the app does this automatically for user-authored content, but agent-authored content written directly via other MCP tools does not go through the app code paths that trigger it.',
    {
      org_id: z.string().describe('Organization UUID that owns the source record'),
      source_type: z.enum(SOURCE_TYPES),
      source_id: z.string().describe('UUID of the record containing the text (the team message, note, etc.)'),
      text: z.string().describe('The full text to parse for @[Name](type:id) mention tokens'),
      created_by: z.string().optional().describe('User UUID to attribute new mention rows to'),
    },
    async ({ org_id, source_type, source_id, text, created_by }) => {
      try {
        const parsed = parseMentions(text);

        const byTarget = new Map<string, { target_type: string; target_id: string; snippet: string }>();
        for (const m of parsed) {
          const key = `${m.type}:${m.id}`;
          if (byTarget.has(key)) continue;
          byTarget.set(key, {
            target_type: m.type,
            target_id: m.id,
            snippet: buildMentionSnippet(text, m.index, m.raw.length),
          });
        }

        const existing = (await restGet('entity_mentions', {
          select: 'id,target_type,target_id',
          filters: {
            source_type: `eq.${source_type}`,
            source_id: `eq.${source_id}`,
          },
        })) as Array<{ id: string; target_type: string; target_id: string }>;

        const existingByKey = new Map(existing.map((row) => [`${row.target_type}:${row.target_id}`, row.id]));

        const toDeleteIds = existing
          .filter((row) => !byTarget.has(`${row.target_type}:${row.target_id}`))
          .map((row) => row.id);

        const toInsert = Array.from(byTarget.entries())
          .filter(([key]) => !existingByKey.has(key))
          .map(([, v]) => ({
            org_id,
            source_type,
            source_id,
            target_type: v.target_type,
            target_id: v.target_id,
            snippet: v.snippet,
            created_by: created_by || null,
          }));

        if (toDeleteIds.length > 0) {
          await restDelete('entity_mentions', { id: `in.(${toDeleteIds.join(',')})` });
        }
        if (toInsert.length > 0) {
          await restPost('entity_mentions', toInsert, 'return=representation');
        }

        return toolResult({
          success: true,
          mentions_found: parsed.length,
          inserted: toInsert.length,
          removed: toDeleteIds.length,
          unchanged: existing.length - toDeleteIds.length,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
