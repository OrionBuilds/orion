import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { parseMentions, buildMentionSnippet } from '../utils/mentionTokens.js';

/**
 * A4: agent-facing surface for /docs. Documents are markdown-native --
 * markdown_cache is the ONLY thing these tools ever read or write; the live
 * Yjs collaboration state (document_updates/document_snapshots, private
 * realtime.messages channel) is a browser-only concern these tools never
 * touch.
 *
 * documents_update_markdown deliberately REFUSES to write when the document
 * already has Yjs history (any document_updates row) -- an agent overwriting
 * markdown_cache on a doc with live collaboration state would get silently
 * clobbered by the next client autosave (5s debounce, always wins), which is
 * worse than refusing outright. This is a documented v1 limitation per the
 * plan; the concrete next step for a "let agents edit live docs too" phase
 * would be a server-side Yjs update the agent generates, not a markdown_cache
 * write race against connected clients.
 */

interface DocumentRow {
  id: string;
  org_id: string;
  title: string;
  markdown_cache: string;
  markdown_rev: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

async function hasYjsHistory(documentId: string): Promise<boolean> {
  const rows = (await restGet('document_updates', {
    select: 'id',
    filters: { document_id: `eq.${documentId}` },
    limit: 1,
  })) as Array<{ id: number }>;
  return rows.length > 0;
}

/** Same diff-based upsert as entity_mentions_sync, scoped to source_type='document'. */
async function syncDocumentMentions(orgId: string, documentId: string, text: string, createdBy?: string): Promise<void> {
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
    filters: { source_type: 'eq.document', source_id: `eq.${documentId}` },
  })) as Array<{ id: string; target_type: string; target_id: string }>;

  const existingByKey = new Map(existing.map((row) => [`${row.target_type}:${row.target_id}`, row.id]));
  const toDeleteIds = existing.filter((row) => !byTarget.has(`${row.target_type}:${row.target_id}`)).map((r) => r.id);
  const toInsert = Array.from(byTarget.entries())
    .filter(([key]) => !existingByKey.has(key))
    .map(([, v]) => ({
      org_id: orgId,
      source_type: 'document',
      source_id: documentId,
      target_type: v.target_type,
      target_id: v.target_id,
      snippet: v.snippet,
      created_by: createdBy || null,
    }));

  if (toDeleteIds.length > 0) await restDelete('entity_mentions', { id: `in.(${toDeleteIds.join(',')})` });
  if (toInsert.length > 0) await restPost('entity_mentions', toInsert, 'return=representation');
}

export function registerDocumentsTools(server: McpServer): void {
  server.tool(
    'documents_list',
    'List documents for an org, most recently updated first.',
    {
      org_id: z.string().describe('Organization UUID'),
      limit: z.number().optional().describe('Max rows, default 50'),
      offset: z.number().optional(),
    },
    async ({ org_id, limit, offset }) => {
      try {
        const data = await restGet('documents', {
          select: 'id,org_id,title,markdown_rev,created_by,updated_by,created_at,updated_at',
          filters: { org_id: `eq.${org_id}` },
          order: 'updated_at.desc',
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
    'documents_get',
    'Get a single document by id, including its full markdown_cache content.',
    { id: z.string().describe('Document UUID') },
    async ({ id }) => {
      try {
        const rows = (await restGet('documents', {
          select: '*',
          filters: { id: `eq.${id}` },
          limit: 1,
        })) as DocumentRow[];
        if (rows.length === 0) throw new Error(`Document ${id} not found`);
        return toolResult(rows[0]);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'documents_search',
    'Full-text search over documents (title + markdown_cache) via the generated search_vector column. Websearch syntax supported (quotes, AND/OR, -exclude).',
    {
      org_id: z.string().describe('Organization UUID'),
      q: z.string().describe('Search query, websearch syntax'),
      limit: z.number().optional().describe('Max rows, default 25'),
    },
    async ({ org_id, q, limit }) => {
      try {
        const trimmed = q.trim();
        if (!trimmed) return toolResult([]);
        const data = await restGet('documents', {
          select: 'id,org_id,title,markdown_rev,updated_at',
          filters: { org_id: `eq.${org_id}`, search_vector: `wfts(english).${trimmed}` },
          order: 'updated_at.desc',
          limit: limit || 25,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'documents_create',
    'Create a new markdown document. It starts with no Yjs collaboration state -- opening it in the /docs editor bootstraps the live Y.Doc FROM this markdown_cache automatically, which is how agent-created docs enter real-time co-editing.',
    {
      org_id: z.string().describe('Organization UUID'),
      title: z.string().optional().describe('Defaults to "Untitled"'),
      markdown: z.string().optional().describe('Initial markdown content, defaults to empty'),
      created_by: z.string().optional().describe('User UUID to attribute authorship to'),
    },
    async ({ org_id, title, markdown, created_by }) => {
      try {
        const data = await restPost(
          'documents',
          {
            org_id,
            title: title?.trim() || 'Untitled',
            markdown_cache: markdown || '',
            created_by: created_by || null,
            updated_by: created_by || null,
          },
          'return=representation',
        );
        const created = (data as DocumentRow[])[0];
        if (created && markdown) {
          await syncDocumentMentions(org_id, created.id, markdown, created_by).catch((e) =>
            console.error('documents_create: mention sync failed (non-fatal):', e),
          );
        }
        return toolResult(created);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'documents_update_markdown',
    'Overwrite a document\'s markdown_cache (and bump markdown_rev). REFUSES if the document already has live Yjs collaboration history (any document_updates row) -- editing markdown_cache directly on a doc being co-edited would get clobbered by the next client autosave. Use documents_get first to check, or catch the refusal and tell the user to edit the doc in-app instead.',
    {
      id: z.string().describe('Document UUID'),
      markdown: z.string().describe('New full markdown content (replaces markdown_cache entirely)'),
      title: z.string().optional().describe('Optionally also update the title'),
      updated_by: z.string().optional().describe('User UUID to attribute the edit to'),
    },
    async ({ id, markdown, title, updated_by }) => {
      try {
        if (await hasYjsHistory(id)) {
          throw new Error(
            `Document ${id} already has live collaboration history -- refusing to overwrite markdown_cache directly (it would be clobbered by the next autosave from a connected editor). Edit it in the /docs UI instead.`,
          );
        }

        const rows = (await restGet('documents', {
          select: 'id,org_id,markdown_rev',
          filters: { id: `eq.${id}` },
          limit: 1,
        })) as Array<{ id: string; org_id: string; markdown_rev: number }>;
        if (rows.length === 0) throw new Error(`Document ${id} not found`);
        const current = rows[0];

        const body: Record<string, unknown> = {
          markdown_cache: markdown,
          markdown_rev: (current.markdown_rev || 0) + 1,
          updated_at: new Date().toISOString(),
        };
        if (title) body.title = title;
        if (updated_by) body.updated_by = updated_by;

        const data = await restPatch('documents', { id: `eq.${id}` }, body, 'return=representation');

        await syncDocumentMentions(current.org_id, id, markdown, updated_by).catch((e) =>
          console.error('documents_update_markdown: mention sync failed (non-fatal):', e),
        );

        return toolResult((data as DocumentRow[])[0]);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'document_backlinks',
    'Get everything that @mentions a given document -- same entity_mentions backlinks data the ReferencesPanel shows in the app, for target_type="document".',
    {
      document_id: z.string().describe('Document UUID'),
      limit: z.number().optional().describe('Max rows, default 50'),
    },
    async ({ document_id, limit }) => {
      try {
        const data = await restGet('entity_mentions', {
          select: '*,created_by_user:users!entity_mentions_created_by_fkey(id,name,avatar_url)',
          filters: { target_type: 'eq.document', target_id: `eq.${document_id}` },
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
