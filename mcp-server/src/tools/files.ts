import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete } from '../helpers/rest-client.js';
import { callEdgeFunction, callEdgeRoute } from '../helpers/edge-client.js';
import {
  connectRoute,
  filesRoute,
  providerParam,
  resolveWorkspaceProvider,
  type RequestedProvider,
} from '../helpers/workspace-provider.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';

export function registerFilesTools(server: McpServer): void {
  server.tool(
    'drive_files_list',
    'List cached file records (Google Drive or SharePoint/OneDrive items), optionally filtered by parent folder id or provider',
    {
      folder_id: z.string().optional().describe('Provider folder id (parent_drive_folder_id)'),
      provider: z.enum(['google', 'microsoft']).optional().describe('Only files from this storage provider'),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ folder_id, provider, order, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (folder_id) filters['parent_drive_folder_id'] = `eq.${folder_id}`;
        if (provider) filters['provider'] = `eq.${provider}`;
        const data = await restGet('drive_files', {
          filters,
          order: order || 'name.asc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_files_get',
    'Get file detail',
    { id: z.string() },
    async ({ id }) => {
      try {
        const data = await restGet('drive_files', {
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
    'drive_files_create',
    'Create a cached file record for a Google Drive or SharePoint/OneDrive item',
    {
      name: z.string(),
      drive_file_id: z.string().optional().describe('The provider item id'),
      google_file_id: z.string().optional().describe('Legacy alias of drive_file_id'),
      folder_id: z.string().optional().describe('Provider parent folder id'),
      mime_type: z.string().optional(),
      size: z.number().optional(),
      provider: z.enum(['google', 'microsoft']).optional().describe('Storage provider of the item (default: the caller\'s connected provider)'),
      organization_id: z.string().optional(),
    },
    async ({ name, drive_file_id, google_file_id, folder_id, mime_type, size, provider, organization_id }) => {
      try {
        const p = provider ?? (await resolveWorkspaceProvider('auto').catch(() => null));
        const row: Record<string, unknown> = {
          name,
          drive_file_id: drive_file_id ?? google_file_id,
          parent_drive_folder_id: folder_id,
          mime_type,
          size_bytes: size,
          organization_id,
        };
        if (p) row.provider = p;
        const data = await restPost('drive_files', row, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_files_update',
    'Update file metadata',
    {
      id: z.string(),
      name: z.string().optional(),
      folder_id: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('drive_files', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_files_delete',
    'Delete a file record',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('drive_files', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_folders_list',
    'List folders. Use parent_id to get subfolders, omit for root folders.',
    {
      parent_id: z.string().optional().describe('Omit for root folders, or set to folder id for subfolders'),
      limit: z.number().optional(),
    },
    async ({ parent_id, limit }) => {
      try {
        const filters: Record<string, string> = {};
        filters['parent_drive_folder_id'] = parent_id ? `eq.${parent_id}` : 'is.null';
        const data = await restGet('drive_folders', {
          filters,
          order: 'name.asc',
          limit: limit || 100,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_folders_create',
    'Create a folder',
    {
      name: z.string(),
      parent_id: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        const data = await restPost('drive_folders', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_folders_update',
    'Update a folder',
    {
      id: z.string(),
      name: z.string().optional(),
      parent_id: z.string().optional(),
    },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('drive_folders', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_folders_delete',
    'Delete a folder',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('drive_folders', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'file_attachments_list',
    'List file attachments linked to an entity',
    {
      entity_type: z.string().optional().describe('e.g. contact, opportunity, project'),
      entity_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ entity_type, entity_id, limit }) => {
      try {
        const filters: Record<string, string> = {};
        if (entity_type) filters['entity_type'] = `eq.${entity_type}`;
        if (entity_id) filters['entity_id'] = `eq.${entity_id}`;
        const data = await restGet('file_attachments', {
          select: '*,file:drive_files(id,name,mime_type,size_bytes)',
          filters,
          order: 'attached_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'file_attachments_create',
    'Link a file to an entity',
    {
      file_id: z.string(),
      entity_type: z.string(),
      entity_id: z.string(),
    },
    async (params) => {
      try {
        const data = await restPost('file_attachments', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'file_attachments_delete',
    'Remove a file attachment link',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('file_attachments', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // File storage: Google Drive (drive-api) or SharePoint/OneDrive (sharepoint-api, Drive-shaped).
  const storageSchema = {
    action: z.string().describe(
      'Both: list { folderId? }, search { query }, get-metadata (get) { fileId }, create-folder { name, parentId? }, delete { fileId }, get-share-link { fileId }, get-download-url { fileId }. Google only: list-shared-drives, list-shared-with-me, share, export-doc, enrich-meeting(s-batch).',
    ),
    payload: z.record(z.unknown()).optional(),
    provider: providerParam,
  };
  const storageHandler = async ({ action, payload, provider }: { action: string; payload?: Record<string, unknown>; provider?: RequestedProvider }) => {
    try {
      const p = await resolveWorkspaceProvider(provider);
      const data = await callEdgeRoute(filesRoute(p, action, payload ?? {}));
      return toolResult({ provider: p, ...(typeof data === 'object' && data !== null ? data : { result: data }) });
    } catch (e) {
      return toolError(e);
    }
  };
  server.tool('file_storage_api', "The caller's file storage (Google Drive or SharePoint/OneDrive, whichever is connected).", storageSchema, storageHandler);
  server.tool('drive_api', 'Legacy alias of file_storage_api (Google Drive or SharePoint/OneDrive by connected provider).', storageSchema, storageHandler);

  server.tool(
    'drive_oauth_start',
    'Start connecting file storage: Google Drive (Google Workspace) or SharePoint/OneDrive (Microsoft 365). Returns an authUrl.',
    { redirect_uri: z.string().optional(), provider: providerParam },
    async ({ redirect_uri, provider }) => {
      try {
        const p = provider === 'google' || provider === 'microsoft' ? provider
          : await resolveWorkspaceProvider(provider).catch(() => 'google' as const);
        const data = p === 'google'
          ? await callEdgeFunction('drive-oauth-start', { redirect_uri })
          : await callEdgeRoute(connectRoute('microsoft'));
        return toolResult({ provider: p, ...(data as object) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_oauth_callback',
    'Handle Google Drive OAuth callback (Google only; Microsoft 365 completes its OAuth in microsoft-oauth-callback)',
    { code: z.string(), state: z.string().optional() },
    async (params) => {
      try {
        const data = await callEdgeFunction('drive-oauth-callback', params);
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'drive_auto_connect',
    'Auto-connect and configure the file-storage folder structure (Google Drive). SharePoint/OneDrive needs no setup beyond the Microsoft 365 connection.',
    { create_default_folders: z.boolean().optional(), provider: providerParam },
    async ({ create_default_folders, provider }) => {
      try {
        const p = await resolveWorkspaceProvider(provider);
        if (p === 'microsoft') {
          return toolResult({ provider: p, connected: true, note: 'SharePoint/OneDrive is available through the Microsoft 365 connection; no separate Drive setup is needed.' });
        }
        const data = await callEdgeFunction('drive-auto-connect', { create_default_folders });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
