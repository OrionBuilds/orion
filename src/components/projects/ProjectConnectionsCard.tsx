/**
 * Connections — the GitHub repos, Supabase project, Netlify site and files folder (Google Drive or
 * SharePoint/OneDrive) this project is built from. Lives in the project detail side panel. The OS
 * is the source of truth; FRIDAY picks up edits on its next sync (and writes back repos it creates).
 */
import { useState, type ReactNode } from 'react';
import { Database, FolderOpen, Github, Globe, Link2, Loader2, Pencil, Plus, X } from 'lucide-react';
import type { Project } from '../../types';
import { getErrorMessage } from '../../lib/errors';
import {
  folderFields,
  normalizeGithubRepo,
  normalizeSiteUrl,
  parseSupabaseRef,
  repoLabel,
  saveProjectConnections,
  supabaseDashboardUrl,
  type ConnectionsPatch,
} from '../../services/projectConnections';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { GithubRepoResults } from './GithubRepoResults';

type Editing = 'repo' | 'supabase' | 'netlify' | 'staging' | null;

export function ProjectConnectionsCard({
  project,
  canEdit,
  currentUserId,
  onUpdate,
}: {
  project: Project;
  canEdit: boolean;
  currentUserId: string;
  onUpdate: (p: Project) => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const repos = project.repo_urls ?? [];

  const save = async (patch: ConnectionsPatch) => {
    setSaving(true);
    setError(null);
    try {
      // updateProject returns the bare row; keep the joined relations the page already has.
      const updated = await saveProjectConnections(project.id, patch, currentUserId);
      onUpdate({ ...project, ...patch, connections_updated_at: updated.connections_updated_at });
      setEditing(null);
      setValue('');
    } catch (e) {
      setError(getErrorMessage(e, 'Could not save the connection'));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (what: Editing, initial = '') => {
    setEditing(what);
    setValue(initial);
    setError(null);
  };

  const submit = () => {
    if (editing === 'repo') {
      const url = normalizeGithubRepo(value);
      if (!url) return setError('Use owner/repo or a github.com URL');
      if (repos.some((r) => r.toLowerCase() === url.toLowerCase())) return setError('That repo is already connected');
      return save({ repo_urls: [...repos, url] });
    }
    if (editing === 'supabase') {
      const ref = parseSupabaseRef(value);
      if (!ref) return setError('Use the 20-letter project ref or the project URL');
      return save({ supabase_project_ref: ref });
    }
    if (editing === 'netlify') {
      const url = normalizeSiteUrl(value);
      if (!url) return setError('Use the site address, e.g. client.netlify.app');
      return save({ netlify_site_url: url });
    }
    if (editing === 'staging') {
      const url = normalizeSiteUrl(value);
      if (!url) return setError('Use the staging address, e.g. staging.client.com');
      return save({ staging_url: url });
    }
  };

  const input = (placeholder: string) => (
    <div className="mt-1.5 space-y-1.5">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') setEditing(null);
        }}
        placeholder={placeholder}
        className="w-full bg-hud-bg-mid border border-hud-bg-elev rounded-md px-2 py-1 text-xs text-white placeholder:text-hud-cream-dim focus:outline-none focus:border-hud-gold"
      />
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !value.trim()} className="px-2 py-1 rounded-md text-xs bg-hud-gold-deep text-white disabled:opacity-40">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
        </button>
        <button onClick={() => setEditing(null)} className="px-2 py-1 rounded-md text-xs text-hud-cream-dim hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  );

  const folderLabel =
    project.files_provider === 'google' ? 'Google Drive' : project.files_provider === 'microsoft' ? 'SharePoint / OneDrive' : '';

  return (
    <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="w-3.5 h-3.5 text-hud-cream-dim" />
        <span className="text-xs text-hud-cream-mute uppercase tracking-wide">Connections</span>
      </div>

      <div className="space-y-3">
        <Row icon={Github} label="GitHub">
          {repos.length === 0 && editing !== 'repo' && <Empty />}
          {repos.map((r) => (
            <div key={r} className="flex items-center gap-1 group">
              <ExtLink href={r}>{repoLabel(r)}</ExtLink>
              {canEdit && (
                <button
                  onClick={() => save({ repo_urls: repos.filter((x) => x !== r) })}
                  disabled={saving}
                  className="ml-auto p-0.5 text-hud-cream-mute hover:text-hud-plum opacity-0 group-hover:opacity-100 reveal-on-touch focus:opacity-100"
                  aria-label={`Disconnect ${repoLabel(r)}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {editing === 'repo' ? (
            <>
              {input('Search your repos, or paste a link')}
              <div className="mt-1.5">
                <GithubRepoResults query={value} exclude={repos} onPick={(url) => save({ repo_urls: [...repos, url] })} />
              </div>
            </>
          ) : canEdit && (
                <button onClick={() => startEdit('repo')} className="mt-1 flex items-center gap-1 text-xs text-hud-cream-dim hover:text-white">
                  <Plus className="w-3 h-3" /> Add repo
                </button>
              )}
        </Row>

        <Row
          icon={Database}
          label="Supabase"
          onEdit={canEdit && editing !== 'supabase' ? () => startEdit('supabase', project.supabase_project_ref ?? '') : undefined}
          onClear={canEdit && project.supabase_project_ref ? () => save({ supabase_project_ref: null }) : undefined}
        >
          {editing === 'supabase'
            ? input('Project ref or URL')
            : project.supabase_project_ref
              ? <ExtLink href={supabaseDashboardUrl(project.supabase_project_ref)}>{project.supabase_project_ref}</ExtLink>
              : <Empty />}
        </Row>

        <Row
          icon={Globe}
          label="Netlify"
          onEdit={canEdit && editing !== 'netlify' ? () => startEdit('netlify', project.netlify_site_url ?? '') : undefined}
          onClear={canEdit && project.netlify_site_url ? () => save({ netlify_site_url: null }) : undefined}
        >
          {editing === 'netlify'
            ? input('Site address')
            : project.netlify_site_url
              ? <ExtLink href={project.netlify_site_url}>{project.netlify_site_url.replace(/^https?:\/\//, '')}</ExtLink>
              : <Empty />}
        </Row>

        <Row
          icon={Globe}
          label="Staging"
          onEdit={canEdit && editing !== 'staging' ? () => startEdit('staging', project.staging_url ?? '') : undefined}
          onClear={canEdit && project.staging_url ? () => save({ staging_url: null }) : undefined}
        >
          {editing === 'staging'
            ? input('Staging address')
            : project.staging_url
              ? <ExtLink href={project.staging_url}>{project.staging_url.replace(/^https?:\/\//, '')}</ExtLink>
              : <Empty />}
        </Row>

        <Row
          icon={FolderOpen}
          label={folderLabel ? `Files · ${folderLabel}` : 'Files'}
          onEdit={canEdit ? () => setPicking(true) : undefined}
          onClear={canEdit && project.files_folder_id ? () => save(folderFields(null)) : undefined}
        >
          {project.files_folder_id ? (
            project.files_folder_url ? (
              <ExtLink href={project.files_folder_url}>{project.files_folder_name || 'Open folder'}</ExtLink>
            ) : (
              <span className="text-xs text-hud-cream-soft">{project.files_folder_name || project.files_folder_id}</span>
            )
          ) : canEdit ? (
            <button onClick={() => setPicking(true)} className="text-xs text-hud-cream-dim hover:text-white flex items-center gap-1">
              <Plus className="w-3 h-3" /> Choose folder
            </button>
          ) : (
            <Empty />
          )}
        </Row>
      </div>

      {error && <p className="mt-2 text-xs text-hud-plum">{error}</p>}

      {picking && (
        <ProjectFolderPicker
          onClose={() => setPicking(false)}
          onPick={(f) => {
            setPicking(false);
            void save(folderFields(f));
          }}
        />
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  onEdit,
  onClear,
  children,
}: {
  icon: React.ElementType;
  label: string;
  onEdit?: () => void;
  onClear?: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-hud-cream-dim" />
        <span className="text-xs text-hud-cream-mute">{label}</span>
        <span className="ml-auto flex items-center gap-0.5">
          {onEdit && (
            <button onClick={onEdit} className="p-0.5 text-hud-cream-mute hover:text-white" aria-label={`Edit ${label}`}>
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {onClear && (
            <button onClick={onClear} className="p-0.5 text-hud-cream-mute hover:text-hud-plum" aria-label={`Disconnect ${label}`}>
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      </div>
      <div className="mt-1 pl-5 min-w-0">{children}</div>
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-xs text-hud-cream-soft hover:text-white truncate block">
      {children}
    </a>
  );
}

function Empty() {
  return <span className="text-xs text-hud-cream-mute">Not connected</span>;
}
