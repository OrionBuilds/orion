import { supabase } from '../lib/supabase';

/**
 * FRIDAY / CLARA Obsidian vaults, mirrored from the owner's Linux box by FRIDAY's vault-sync job.
 * Read-only and SuperAdmin-only (RLS); see migration *_memory_vault.sql.
 */
export type VaultName = 'friday' | 'clara' | 'harvey';

export interface VaultGraphNode { id: string; title: string; group: string; degree: number; mtime: number }
export interface VaultGraph { nodes: VaultGraphNode[]; links: { source: string; target: string }[] }

export interface VaultNoteSummary { vault: VaultName; path: string; title: string; folder: string; mtime: string }
export interface VaultSearchHit extends VaultNoteSummary { preview: string; rank: number }
export interface VaultNote extends VaultNoteSummary { content: string }

export interface VaultSyncStatus {
  vault: VaultName;
  last_synced_at: string | null;
  note_count: number;
  link_count: number;
  last_error: string | null;
}

export async function getVaultGraph(vault: VaultName): Promise<VaultGraph> {
  const { data, error } = await supabase.rpc('vault_graph', { p_vault: vault });
  if (error) throw new Error(error.message);
  return (data as VaultGraph | null) ?? { nodes: [], links: [] };
}

export async function searchVault(query: string, vault: VaultName, limit = 40): Promise<VaultSearchHit[]> {
  const { data, error } = await supabase.rpc('search_vault_notes', { p_query: query, p_vault: vault, p_limit: limit });
  if (error) throw new Error(error.message);
  return (data ?? []) as VaultSearchHit[];
}

export async function getRecentVaultNotes(vault: VaultName, limit = 40): Promise<VaultNoteSummary[]> {
  const { data, error } = await supabase
    .from('vault_notes')
    .select('vault, path, title, folder, mtime')
    .eq('vault', vault)
    .order('mtime', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as VaultNoteSummary[];
}

export async function getVaultNote(vault: VaultName, path: string): Promise<VaultNote | null> {
  const { data, error } = await supabase
    .from('vault_notes')
    .select('vault, path, title, folder, mtime, content')
    .eq('vault', vault)
    .eq('path', path)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as VaultNote | null;
}

export async function getVaultSyncStatus(): Promise<VaultSyncStatus[]> {
  const { data, error } = await supabase
    .from('vault_sync_status')
    .select('vault, last_synced_at, note_count, link_count, last_error');
  if (error) throw new Error(error.message);
  return (data ?? []) as VaultSyncStatus[];
}
