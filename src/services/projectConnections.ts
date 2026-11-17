// Project connections: the GitHub repos, Supabase project, Netlify site and files folder a project
// is built from. Stored on `projects` (migration *_project_connections) and edited on the project
// detail card. FRIDAY syncs with them both ways, last writer wins on connections_updated_at, so
// every save here stamps it.
import type { Project } from '../types';
import type { WorkspaceProvider } from './connectedProvider';
import { updateProject } from './projects';

export type ConnectionsPatch = Partial<Pick<Project,
  | 'repo_urls' | 'supabase_project_ref' | 'netlify_site_url' | 'staging_url'
  | 'files_provider' | 'files_drive_id' | 'files_folder_id' | 'files_folder_name' | 'files_folder_url'>>;

export interface PickedFolder {
  provider: WorkspaceProvider;
  driveId: string | null;
  id: string;
  name: string;
  url: string | null;
}

/** "owner/repo", a github.com URL (any path, optional .git) or an SSH remote -> canonical https URL. */
export function normalizeGithubRepo(input: string): string | null {
  const s = input.trim();
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i) ??
    s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  const [owner, repo] = [m[1], m[2]];
  if (!owner || !repo || owner.startsWith('.') || repo.startsWith('.')) return null;
  return `https://github.com/${owner}/${repo}`;
}

/** A 20-letter project ref, or the ref inside a *.supabase.co URL or a dashboard URL. */
export function parseSupabaseRef(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m =
    s.match(/^([a-z]{20})$/) ??
    s.match(/^(?:https?:\/\/)?([a-z]{20})\.supabase\.(?:co|in)\b/) ??
    s.match(/supabase\.com\/dashboard\/project\/([a-z]{20})\b/);
  return m ? m[1] : null;
}

/** A site address with or without scheme -> https URL without a trailing slash. */
export function normalizeSiteUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function repoLabel(url: string): string {
  return url.replace(/^https:\/\/github\.com\//, '');
}

export function supabaseDashboardUrl(ref: string): string {
  return `https://supabase.com/dashboard/project/${ref}`;
}

export function folderFields(folder: PickedFolder | null): ConnectionsPatch {
  return folder
    ? {
        files_provider: folder.provider,
        files_drive_id: folder.driveId,
        files_folder_id: folder.id,
        files_folder_name: folder.name,
        files_folder_url: folder.url,
      }
    : { files_provider: null, files_drive_id: null, files_folder_id: null, files_folder_name: null, files_folder_url: null };
}

export async function saveProjectConnections(projectId: string, patch: ConnectionsPatch, actorUserId: string): Promise<Project> {
  return updateProject(projectId, { ...patch, connections_updated_at: new Date().toISOString() }, actorUserId);
}
