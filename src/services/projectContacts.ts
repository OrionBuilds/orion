// Portal access membership for a project (project_contacts).
//
// A project's primary contact (projects.contact_id) is mirrored into
// project_contacts by trigger; additional POCs added here get exactly the same
// client-portal visibility — the portal edge function authorizes every read
// against this membership set. This service backs the Portal Access card on the
// project detail page so the owner can grant/revoke access and send invites
// without touching the database.

import { supabase } from '../lib/supabase';

export interface ProjectContactMember {
  id: string;
  project_id: string;
  contact_id: string;
  role: 'primary' | 'poc' | 'billing' | 'technical';
  created_at: string;
  contact: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    company: string | null;
  } | null;
}

export async function listProjectContacts(projectId: string): Promise<ProjectContactMember[]> {
  const { data, error } = await supabase
    .from('project_contacts')
    .select('*, contact:contacts(id, first_name, last_name, email, company)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ProjectContactMember[];
}

export async function addProjectContact(params: {
  orgId: string;
  projectId: string;
  contactId: string;
  role?: 'poc' | 'billing' | 'technical';
  addedByUserId?: string;
}): Promise<void> {
  const { error } = await supabase.from('project_contacts').insert({
    org_id: params.orgId,
    project_id: params.projectId,
    contact_id: params.contactId,
    role: params.role ?? 'poc',
    added_by_user_id: params.addedByUserId ?? null,
  });
  if (error) {
    // unique(project_id, contact_id) — a duplicate grant is not an error worth surfacing
    if (error.code === '23505') return;
    throw error;
  }
}

export async function removeProjectContact(memberId: string): Promise<void> {
  const { error } = await supabase.from('project_contacts').delete().eq('id', memberId);
  if (error) throw error;
}

/** Search org contacts by name/email for the add-POC picker. */
export async function searchContactsForPortal(query: string, limit = 8): Promise<ProjectContactMember['contact'][]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const { data, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, company')
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`)
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as ProjectContactMember['contact'][];
}

/** Create a contact inline when the person doesn't exist yet. */
export async function createPortalContact(params: {
  orgId: string;
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  ownerUserId?: string;
}): Promise<string> {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      organization_id: params.orgId,
      owner_id: params.ownerUserId ?? null,
      first_name: params.firstName,
      last_name: params.lastName,
      email: params.email,
      company: params.company ?? null,
      status: 'active',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}
