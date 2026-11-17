import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Loader2, Calendar, Link2, Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getProjects, updateProject } from '../../services/projects';
import type { Project } from '../../types';
import { formatCurrency, formatDateShort } from '../../utils/formatters';

interface ContactProjectsTabProps {
  contactId: string;
  projects: Project[];
  isLoading: boolean;
  /** Called after a project is linked, so the parent reloads the list. */
  onLinked: (project: Project) => void;
}

// Link an existing project to this contact (makes the contact the project's primary contact).
function LinkProjectPanel({ contactId, linkedIds, onLinked }: {
  contactId: string;
  linkedIds: Set<string>;
  onLinked: (project: Project) => void;
}) {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Project[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const t = setTimeout(() => {
      getProjects(user.organization_id, { search: search.trim() || undefined }, 1, 12)
        .then(({ data }) => { if (!cancelled) setResults(data.filter((p) => !linkedIds.has(p.id))); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [user, search, linkedIds]);

  async function link(p: Project) {
    if (!user) return;
    if (p.contact_id && p.contact_id !== contactId) {
      const who = p.contact ? `${p.contact.first_name} ${p.contact.last_name || ''}`.trim() : 'another contact';
      if (!window.confirm(`"${p.name}" is currently linked to ${who}. Move it to this contact?`)) return;
    }
    setSaving(p.id);
    setError(null);
    try {
      onLinked(await updateProject(p.id, { contact_id: contactId } as Partial<Project>, user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link the project');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="bg-hud-bg-card/50 border border-hud-bg-elev rounded-lg p-3 mb-3">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-hud-cream-dim" />
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-hud-bg-mid border border-hud-cream-mute rounded-lg pl-7 pr-2 py-1.5 text-white text-xs focus:outline-none focus:ring-2 focus:ring-hud-gold"
          placeholder="Search projects..."
        />
      </div>
      {results.length > 0 ? (
        <ul className="mt-2 max-h-56 overflow-y-auto divide-y divide-hud-bg-elev/50">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={saving !== null}
                onClick={() => void link(p)}
                className="w-full text-left px-2 py-1.5 hover:bg-hud-bg-elev rounded flex items-center justify-between gap-3 disabled:opacity-50"
              >
                <span className="text-xs text-white truncate">{p.name}</span>
                <span className="text-xs text-hud-cream-mute shrink-0">
                  {saving === p.id ? 'Linking...' : p.contact ? `${p.contact.first_name} ${p.contact.last_name || ''}`.trim() : 'No contact'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-hud-cream-mute">No matching projects.</p>
      )}
      {error && <p className="mt-2 text-xs text-hud-plum">{error}</p>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-hud-emerald/20 text-hud-emerald',
  on_hold: 'bg-hud-rust/20 text-hud-rust',
  completed: 'bg-hud-emerald/20 text-hud-emerald',
  cancelled: 'bg-hud-plum/20 text-hud-plum',
};

export function ContactProjectsTab({ contactId, projects, isLoading, onLinked }: ContactProjectsTabProps) {
  const [linking, setLinking] = useState(false);
  const linkedIds = new Set(projects.map((p) => p.id));
  const handleLinked = (p: Project) => { setLinking(false); onLinked(p); };

  const linkControl = (
    <div className="flex justify-end mb-3">
      <button
        type="button"
        onClick={() => setLinking((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-hud-gold-soft hover:bg-hud-bg-elev text-xs"
      >
        <Link2 className="w-3.5 h-3.5" />
        Link a project
      </button>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div>
        {linkControl}
        {linking && <LinkProjectPanel contactId={contactId} linkedIds={linkedIds} onLinked={handleLinked} />}
      <div className="flex flex-col items-center justify-center py-12 px-4">
        <div className="w-16 h-16 rounded-full bg-hud-bg-card flex items-center justify-center mb-4">
          <FolderKanban className="w-8 h-8 text-hud-cream-mute" />
        </div>
        <h3 className="text-lg font-medium text-white mb-2">No projects yet</h3>
        <p className="text-sm text-hud-cream-dim text-center max-w-md">
          Projects where this contact is the primary contact or has portal access will appear here.
        </p>
      </div>
      </div>
    );
  }

  return (
    <div>
      {linkControl}
      {linking && <LinkProjectPanel contactId={contactId} linkedIds={linkedIds} onLinked={handleLinked} />}
    <div className="space-y-2">
      {projects.map((p) => (
        <div
          key={p.id}
          className="bg-hud-bg-card/50 rounded-lg p-4 border border-hud-bg-elev"
        >
          <div className="flex items-center justify-between gap-3">
            <Link
              to={`/projects/${p.id}`}
              className="text-sm font-medium text-white hover:text-hud-gold-soft truncate"
            >
              {p.name}
            </Link>
            <span className={`text-xs px-2 py-0.5 rounded-full capitalize shrink-0 ${STATUS_STYLES[p.status] || 'text-hud-cream-dim'}`}>
              {p.status.replace('_', ' ')}
            </span>
          </div>
          <p className="text-xs text-hud-cream-mute mt-1">
            {p.pipeline?.name || '-'} / {p.stage?.name || '-'}
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-3">
            <div className="flex items-center gap-2">
              <div className="w-24 bg-hud-bg-elev rounded-full h-1.5">
                <div className="h-full bg-hud-gold rounded-full" style={{ width: `${p.progress_percent}%` }} />
              </div>
              <span className="text-xs text-hud-cream-mute tabular-nums">{p.progress_percent}%</span>
            </div>
            {Number(p.budget_amount) > 0 && (
              <span className="text-xs text-hud-cream-soft tabular-nums">
                {formatCurrency(Number(p.budget_amount), p.currency)}
              </span>
            )}
            {p.target_end_date && (
              <span className="flex items-center gap-1 text-xs text-hud-cream-dim">
                <Calendar className="w-3.5 h-3.5" />
                {/* date-only column: format in UTC so it doesn't shift a day */}
                {formatDateShort(p.target_end_date, { timeZone: 'UTC' })}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
    </div>
  );
}
