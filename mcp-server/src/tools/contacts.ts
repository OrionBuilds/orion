import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restGet, restPost, restPatch, restDelete, restRpc } from '../helpers/rest-client.js';
import { toolResult, toolError } from '../helpers/tool-utils.js';
import { resolveCaller } from '../helpers/pipelineGuard.js';

// contacts has no type column (people only; companies are the contacts.company string). Passing
// `type` used to 400 (create) or be silently dropped; now it is an explicit error.
const UNSUPPORTED_TYPE_NOTE = 'Not supported: contacts are people; use company for the organisation name. Passing it returns an error.';
const UNSUPPORTED_TYPE_ERROR = 'contacts have no "type" field (people only; put the organisation in "company"). Remove "type" and retry.';

export function registerContactsTools(server: McpServer): void {
  server.tool(
    'contact_voice_verify',
    "Verify a caller-supplied client password (6-digit voice PIN) against the contact's stored credential. Call this BEFORE answering a client's questions about their projects, reports, or requests, or accepting new work requests from them. Returns {ok, reason} — reason is one of verified | incorrect | locked | no_pin_set. Never returns the password itself. 5 consecutive wrong attempts auto-lock the credential for 15 minutes.",
    {
      contact_id: z.string().describe('Contact UUID (resolve from the caller phone/email first)'),
      pin: z.string().describe('The 6-digit password exactly as the client gave it'),
    },
    async ({ contact_id, pin }) => {
      try {
        const data = await restRpc('verify_contact_voice_password', {
          p_contact_id: contact_id,
          p_password: pin,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contacts_list',
    'List contacts with owner and tags. Supports filtering by status, source, owner_id and searching by name/email/company.',
    {
      search: z.string().optional().describe('Search across name, email, company'),
      status: z.string().optional().describe('Filter: eq.active or eq.archived (the only contact statuses).'),
      source: z.string().optional(),
      owner_id: z.string().optional(),
      order: z.string().optional().describe('e.g. created_at.desc'),
      limit: z.number().optional().describe('Max rows, default 50'),
      offset: z.number().optional(),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.search) {
          filters['or'] = `(first_name.ilike.*${params.search}*,last_name.ilike.*${params.search}*,email.ilike.*${params.search}*,company.ilike.*${params.search}*)`;
        }
        if (params.status) filters['status'] = params.status;
        if (params.source) filters['source'] = params.source;
        if (params.owner_id) filters['owner_id'] = `eq.${params.owner_id}`;
        const data = await restGet('contacts', {
          select: '*,owner:users!owner_id(id,name),tags:contact_tags(tag:tags(id,name,color))',
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
    'contacts_get',
    'Get a single contact by ID with all relations (owner, tags, notes, tasks)',
    { id: z.string().describe('Contact UUID') },
    async ({ id }) => {
      try {
        const data = await restGet('contacts', {
          select: '*,owner:users!owner_id(id,name),tags:contact_tags(tag:tags(id,name,color)),notes:contact_notes(*),tasks:contact_tasks(*)',
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
    'contacts_create',
    'Create a new contact record',
    {
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      company: z.string().optional(),
      job_title: z.string().nullable().optional(),
      address_line1: z.string().nullable().optional(),
      address_line2: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      postal_code: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      type: z.string().optional().describe(UNSUPPORTED_TYPE_NOTE),
      status: z.enum(['active', 'archived']).optional().describe('Only active or archived; anything else is rejected by the database.'),
      source: z.string().optional(),
      owner_id: z.string().optional(),
      organization_id: z.string().optional(),
    },
    async (params) => {
      try {
        // contacts.organization_id is NOT NULL and RLS requires it to equal the caller's org, so an
        // agent (or anyone) omitting it hit a 403. Default it — and created_by/owner-less rows are fine —
        // from agent_whoami, mirroring projects_create.
        if (params.type !== undefined) return toolError(new Error(UNSUPPORTED_TYPE_ERROR));
        const { type: _type, ...rest } = params;
        const body: Record<string, unknown> = { ...rest };
        if (!body.organization_id) {
          const caller = await resolveCaller();
          if (caller?.organization_id) body.organization_id = caller.organization_id;
        }
        const data = await restPost('contacts', body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contacts_update',
    'Update an existing contact by ID. Persists name, email, phone, company, job_title, address (address_line1/2, city, state, postal_code, country), status, source, owner_id.',
    {
      id: z.string(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      company: z.string().optional(),
      job_title: z.string().nullable().optional(),
      address_line1: z.string().nullable().optional(),
      address_line2: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      postal_code: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      type: z.string().optional().describe(UNSUPPORTED_TYPE_NOTE),
      status: z.enum(['active', 'archived']).optional().describe('Only active or archived; anything else is rejected by the database.'),
      source: z.string().optional(),
      owner_id: z.string().optional(),
    },
    async ({ id, type, ...body }) => {
      try {
        if (type !== undefined) return toolError(new Error(UNSUPPORTED_TYPE_ERROR));
        if (Object.keys(body).length === 0) return toolError(new Error('Nothing to update: pass at least one field.'));
        const data = await restPatch('contacts', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contacts_delete',
    'Delete a contact by ID',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('contacts', { id: `eq.${id}` });
        return toolResult({ success: true, message: 'Contact deleted' });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contacts_bulk_assign_owner',
    'Bulk assign owner to multiple contacts',
    {
      contact_ids: z.array(z.string()).describe('Array of contact UUIDs'),
      owner_id: z.string().describe('New owner UUID'),
    },
    async ({ contact_ids, owner_id }) => {
      try {
        const data = await restPatch(
          'contacts',
          { id: `in.(${contact_ids.join(',')})` },
          { owner_id },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_notes_list',
    'List notes for a specific contact',
    {
      contact_id: z.string(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ contact_id, order, limit }) => {
      try {
        const data = await restGet('contact_notes', {
          filters: { contact_id: `eq.${contact_id}` },
          order: order || 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_notes_create',
    'Create a note on a contact',
    {
      contact_id: z.string(),
      content: z.string(),
      title: z.string().optional(),
      note_type: z.string().optional().describe('Stored in metadata.note_type (there is no note_type column)'),
    },
    async ({ note_type, ...params }) => {
      try {
        // user_id is NOT NULL (the author): the caller. note_type has no column; keep it in metadata.
        const caller = await resolveCaller();
        const data = await restPost('contact_notes', {
          ...params,
          user_id: caller.user_id,
          ...(note_type ? { metadata: { note_type } } : {}),
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_notes_update',
    'Update a contact note',
    { id: z.string(), content: z.string().optional() },
    async ({ id, ...body }) => {
      try {
        const data = await restPatch('contact_notes', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_notes_delete',
    'Delete a contact note',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('contact_notes', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tasks_list',
    'List tasks for a specific contact',
    {
      contact_id: z.string(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ contact_id, order, limit }) => {
      try {
        const data = await restGet('contact_tasks', {
          filters: { contact_id: `eq.${contact_id}` },
          order: order || 'due_date.asc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tasks_create',
    'Create a task on a contact',
    {
      contact_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      due_date: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      assigned_to_user_id: z.string().uuid().optional(),
      assigned_to: z.string().uuid().optional().describe('Deprecated alias of assigned_to_user_id'),
    },
    async ({ assigned_to, ...params }) => {
      try {
        // Real columns: assigned_to_user_id (not assigned_to); created_by_user_id is NOT NULL.
        const caller = await resolveCaller();
        const data = await restPost('contact_tasks', {
          ...params,
          ...(params.assigned_to_user_id ?? assigned_to ? { assigned_to_user_id: params.assigned_to_user_id ?? assigned_to } : {}),
          created_by_user_id: caller.user_id,
        }, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tasks_update',
    'Update a contact task',
    {
      id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      due_date: z.string().optional(),
      status: z.string().optional(),
      priority: z.string().optional(),
      assigned_to_user_id: z.string().uuid().nullable().optional(),
      assigned_to: z.string().uuid().optional().describe('Deprecated alias of assigned_to_user_id'),
    },
    async ({ id, assigned_to, ...rest }) => {
      try {
        const body: Record<string, unknown> = { ...rest };
        if (assigned_to !== undefined && rest.assigned_to_user_id === undefined) body.assigned_to_user_id = assigned_to;
        if (typeof rest.status === 'string') body.completed_at = rest.status === 'completed' ? new Date().toISOString() : null;
        const data = await restPatch('contact_tasks', { id: `eq.${id}` }, body, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tasks_delete',
    'Delete a contact task',
    { id: z.string() },
    async ({ id }) => {
      try {
        await restDelete('contact_tasks', { id: `eq.${id}` });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'tags_list',
    'List all available tags',
    { limit: z.number().optional() },
    async ({ limit }) => {
      try {
        const data = await restGet('tags', { order: 'name.asc', limit: limit || 100 });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'tags_create',
    'Create a new tag',
    { name: z.string(), color: z.string().optional() },
    async (params) => {
      try {
        const data = await restPost('tags', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tags_add',
    'Add tags to contacts (supports bulk)',
    {
      items: z.array(z.object({ contact_id: z.string(), tag_id: z.string() })),
    },
    async ({ items }) => {
      try {
        const data = await restPost('contact_tags', items, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_tags_remove',
    'Remove a tag from a contact',
    { contact_id: z.string(), tag_id: z.string() },
    async ({ contact_id, tag_id }) => {
      try {
        await restDelete('contact_tags', {
          contact_id: `eq.${contact_id}`,
          tag_id: `eq.${tag_id}`,
        });
        return toolResult({ success: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_fields_list',
    'List custom field definitions for an entity type',
    { entity_type: z.string().optional().describe('e.g. contact, opportunity') },
    async ({ entity_type }) => {
      try {
        const filters: Record<string, string> = {};
        if (entity_type) filters['scope'] = `eq.${entity_type}`;
        const data = await restGet('custom_fields', {
          filters,
          order: 'display_order.asc',
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'custom_field_values_set',
    'Set a contact custom field value (upsert on contact + field). entity_id is the contact id.',
    {
      custom_field_id: z.string(),
      entity_id: z.string().describe('Contact id'),
      value: z.string(),
    },
    async ({ custom_field_id, entity_id, value }) => {
      try {
        // Values live in contact_custom_field_values (value is jsonb, unique on contact_id+custom_field_id).
        const data = await restPost(
          'contact_custom_field_values?on_conflict=contact_id,custom_field_id',
          { contact_id: entity_id, custom_field_id, value },
          'resolution=merge-duplicates,return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contacts_merge',
    'Lightweight merge marker: archives the secondary contact and points it at the primary (merged_into_contact_id/merged_at/merged_by_user_id). The full data-fold (tags, timeline) happens app-side; this only sets the merge markers on the secondary record.',
    {
      primary_id: z.string().describe('Surviving contact id'),
      secondary_id: z.string().describe('Contact being merged into the primary'),
      merged_by_user_id: z.string().optional().describe('User performing the merge'),
    },
    async ({ primary_id, secondary_id, merged_by_user_id }) => {
      try {
        const now = new Date().toISOString();
        const body: Record<string, unknown> = {
          status: 'archived',
          merged_into_contact_id: primary_id,
          merged_at: now,
          updated_at: now,
        };
        if (merged_by_user_id) body.merged_by_user_id = merged_by_user_id;
        const data = await restPatch(
          'contacts',
          { id: `eq.${secondary_id}` },
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
    'contact_timeline_list',
    'List timeline events for a contact (newest first)',
    {
      contact_id: z.string(),
      order: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ contact_id, order, limit }) => {
      try {
        const data = await restGet('contact_timeline', {
          filters: { contact_id: `eq.${contact_id}` },
          order: order || 'created_at.desc',
          limit: limit || 50,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_timeline_add',
    'Add a timeline event to a contact',
    {
      contact_id: z.string(),
      event_type: z.string().describe('e.g. created, updated, note_added, tag_added'),
      user_id: z.string().optional(),
      event_data: z.record(z.unknown()).optional(),
    },
    async (params) => {
      try {
        const data = await restPost('contact_timeline', params, 'return=representation');
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  // ── Agent-specific contact metadata (M1) ──────────────────────────────────
  // Agent client fields that aren't contact columns (drive folder ids,
  // bypass policies, portal tokens, report recipients) live in contact_agent_meta,
  // one row per (contact, agent), keyed back to the agent's legacy local client id.

  server.tool(
    'contact_agent_meta_get',
    "Get agent-specific metadata rows from contact_agent_meta (drive folder ids, bypass policies, report recipients, legacy local client id). Filter by contact_id and/or agent; pass local_client_id to map one of the agent's legacy client ids to its OS contact. Omit all filters to list every row for your agent's clients.",
    {
      contact_id: z.string().optional().describe('Contact UUID'),
      agent: z.enum(['friday', 'clara']).optional(),
      local_client_id: z.string().optional().describe("The agent's legacy local client UUID"),
    },
    async (params) => {
      try {
        const filters: Record<string, string> = {};
        if (params.contact_id) filters['contact_id'] = `eq.${params.contact_id}`;
        if (params.agent) filters['agent'] = `eq.${params.agent}`;
        if (params.local_client_id) filters['local_client_id'] = `eq.${params.local_client_id}`;
        const data = await restGet('contact_agent_meta', {
          select: '*,contact:contacts(id,owner_id,first_name,last_name,email,phone,company,job_title,address_line1,city,state,postal_code,status,created_at,updated_at)',
          filters,
          order: 'updated_at.desc',
          limit: 200,
        });
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.tool(
    'contact_agent_meta_set',
    'Create or update the agent-specific metadata row for a contact. `meta` keys are shallow-merged into the existing meta object (pass a key with null to clear it).',
    {
      contact_id: z.string().describe('Contact UUID'),
      agent: z.enum(['friday', 'clara']),
      local_client_id: z.string().optional().describe("The agent's legacy local client UUID, if any"),
      meta: z.record(z.unknown()).describe('Metadata keys to merge (e.g. driveFolderId, reportRecipients)'),
    },
    async ({ contact_id, agent, local_client_id, meta }) => {
      try {
        const existing = (await restGet('contact_agent_meta', {
          filters: { contact_id: `eq.${contact_id}`, agent: `eq.${agent}` },
        })) as Array<{ id: string; meta: Record<string, unknown> }>;
        if (existing.length > 0) {
          const merged = { ...existing[0].meta, ...meta };
          const patch: Record<string, unknown> = { meta: merged, updated_at: new Date().toISOString() };
          if (local_client_id) patch['local_client_id'] = local_client_id;
          const data = await restPatch(
            'contact_agent_meta',
            { id: `eq.${existing[0].id}` },
            patch,
            'return=representation',
          );
          return toolResult(data);
        }
        // org_id comes from the contact row so callers never have to know it
        const contact = (await restGet('contacts', {
          select: 'id,organization_id',
          filters: { id: `eq.${contact_id}` },
          accept: 'application/vnd.pgrst.object+json',
        })) as { id: string; organization_id: string };
        const data = await restPost(
          'contact_agent_meta',
          { org_id: contact.organization_id, contact_id, agent, local_client_id, meta },
          'return=representation',
        );
        return toolResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
