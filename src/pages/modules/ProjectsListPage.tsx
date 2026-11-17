import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  ArrowUpDown,
  ChevronUp,
  ChevronDown,
  Filter,
  Download,
  X,
  AlertTriangle,
  User as UserIcon,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import type { Project, ProjectPipeline, ProjectFilters } from '../../types';
import { getProjects, deleteProjects } from '../../services/projects';
import { getProjectPipelines } from '../../services/projectPipelines';
import { CreateProjectModal } from '../../components/projects/CreateProjectModal';

type SortField = 'name' | 'created_at' | 'budget_amount' | 'target_end_date' | 'progress_percent';
type SortDir = 'asc' | 'desc';

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-hud-emerald/20 text-hud-emerald',
  on_hold: 'bg-hud-rust/20 text-hud-rust',
  completed: 'bg-hud-emerald/20 text-hud-emerald',
  cancelled: 'bg-hud-plum/20 text-hud-plum',
};

const PRIORITY_STYLES: Record<string, string> = {
  low: 'text-hud-cream-dim',
  medium: 'text-blue-400',
  high: 'text-hud-rust',
  urgent: 'text-hud-plum',
};

export function ProjectsListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = usePermission('projects.create');
  const canDelete = usePermission('projects.delete');

  const [projects, setProjects] = useState<Project[]>([]);
  const [pipelines, setPipelines] = useState<ProjectPipeline[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<ProjectFilters>({});
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const perPage = 25;

  useEffect(() => {
    if (user) {
      getProjectPipelines(user.organization_id).then(setPipelines).catch(console.error);
    }
  }, [user]);

  useEffect(() => {
    loadProjects();
  }, [user, page, filters]);

  async function handleDeleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const names = sorted.filter((p) => selectedIds.has(p.id)).slice(0, 5).map((p) => `- ${p.name}`).join('\n');
    const more = ids.length > 5 ? `\n...and ${ids.length - 5} more` : '';
    if (!confirm(`Permanently delete ${ids.length} project${ids.length === 1 ? '' : 's'}? This cannot be undone.\n\n${names}${more}`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const removed = await deleteProjects(ids);
      if (removed < ids.length) setDeleteError(`Deleted ${removed} of ${ids.length}; you may not have permission for the rest.`);
      setSelectedIds(new Set());
      await loadProjects();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete the selected projects');
    } finally {
      setDeleting(false);
    }
  }

  async function loadProjects() {
    if (!user) return;
    setSelectedIds(new Set());
    setLoading(true);
    try {
      const { data, count } = await getProjects(user.organization_id, filters, page, perPage);
      setProjects(data);
      setTotalCount(count);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const sorted = [...projects].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const av = a[sortField] ?? '';
    const bv = b[sortField] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === sorted.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sorted.map((p) => p.id)));
    }
  }

  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, totalCount);

  function SortHeader({ field, children }: { field: SortField; children: React.ReactNode }) {
    const active = sortField === field;
    return (
      <button
        onClick={() => handleSort(field)}
        className="flex items-center gap-1 text-xs font-medium text-hud-cream-dim hover:text-white transition-colors"
      >
        {children}
        {active ? (
          sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
    );
  }

  function isOverdue(p: Project): boolean {
    return p.status === 'active' && !!p.target_end_date && p.target_end_date < new Date().toISOString().split('T')[0];
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-none px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            value={filters.pipelineId || ''}
            onChange={(e) => setFilters({ ...filters, pipelineId: e.target.value || undefined })}
            className="bg-hud-bg-card border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm"
          >
            <option value="">All Pipelines</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              showFilters ? 'bg-hud-gold-deep text-white' : 'bg-hud-bg-card text-hud-cream-soft border border-hud-cream-mute hover:bg-hud-bg-elev'
            }`}
          >
            <Filter className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          {canCreate && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          )}
        </div>
      </div>

      {showFilters && (
        <div className="flex-none px-6 pb-3">
          <div className="flex items-center gap-2 p-3 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50">
            {(['active', 'on_hold', 'completed', 'cancelled'] as const).map((s) => {
              const active = filters.status?.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => {
                    const curr = filters.status || [];
                    const next = active ? curr.filter((x) => x !== s) : [...curr, s];
                    setFilters({ ...filters, status: next.length > 0 ? next : undefined });
                  }}
                  className={`px-2.5 py-1 text-xs rounded capitalize ${
                    active ? 'bg-hud-gold-deep text-white' : 'bg-hud-bg-elev text-hud-cream-dim'
                  }`}
                >
                  {s.replace('_', ' ')}
                </button>
              );
            })}
            <button onClick={() => { setFilters({}); setShowFilters(false); }} className="ml-auto p-1 text-hud-cream-dim hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {(selectedIds.size > 0 || deleteError) && (
        <div className="flex-none px-6 pb-3">
          <div className="flex items-center gap-3 p-3 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50">
            {selectedIds.size > 0 && <span className="text-sm text-white">{selectedIds.size} selected</span>}
            {canDelete && selectedIds.size > 0 && (
              <button
                onClick={handleDeleteSelected}
                disabled={deleting}
                className="px-3 py-1.5 bg-hud-rust/80 text-white rounded-lg text-sm hover:bg-hud-rust disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete selected'}
              </button>
            )}
            {selectedIds.size > 0 && (
              <button onClick={() => setSelectedIds(new Set())} className="text-sm text-hud-cream-dim hover:text-white">
                Clear
              </button>
            )}
            {deleteError && <span className="text-sm text-red-400">{deleteError}</span>}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto px-6">
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-hud-bg-mid z-10">
            <tr className="border-b border-hud-bg-elev">
              <th className="py-3 px-2 w-10">
                <input
                  type="checkbox"
                  checked={selectedIds.size === sorted.length && sorted.length > 0}
                  onChange={toggleSelectAll}
                  className="rounded border-hud-cream-mute bg-hud-bg-card"
                />
              </th>
              <th className="py-3 px-3 text-left"><SortHeader field="name">Project</SortHeader></th>
              <th className="py-3 px-3 text-left text-xs font-medium text-hud-cream-dim">Contact</th>
              <th className="py-3 px-3 text-left text-xs font-medium text-hud-cream-dim">Pipeline / Stage</th>
              <th className="py-3 px-3 text-left text-xs font-medium text-hud-cream-dim">Status</th>
              <th className="py-3 px-3 text-left text-xs font-medium text-hud-cream-dim">Owner</th>
              <th className="py-3 px-3 text-left text-xs font-medium text-hud-cream-dim">Priority</th>
              <th className="py-3 px-3 text-left"><SortHeader field="progress_percent">Progress</SortHeader></th>
              <th className="py-3 px-3 text-right"><SortHeader field="budget_amount">Budget</SortHeader></th>
              <th className="py-3 px-3 text-left"><SortHeader field="target_end_date">Target End</SortHeader></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="py-12 text-center">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold mx-auto" />
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="py-12 text-center text-hud-cream-mute text-sm">No projects found</td>
              </tr>
            )}
            {!loading && sorted.map((p) => (
              <tr
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="border-b border-hud-bg-card hover:bg-hud-bg-card/50 cursor-pointer transition-colors"
              >
                <td className="py-3 px-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    className="rounded border-hud-cream-mute bg-hud-bg-card"
                  />
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white font-medium">{p.name}</span>
                    {isOverdue(p) && <AlertTriangle className="w-3.5 h-3.5 text-hud-plum" />}
                  </div>
                </td>
                <td className="py-3 px-3 text-sm text-hud-cream-dim truncate max-w-[160px]">
                  {/* BUG FIX (flagged): Contact has first_name/last_name, not `name` — this always showed '-' */}
                  {(p.contact ? `${p.contact.first_name} ${p.contact.last_name}`.trim() : '') || '-'}
                </td>
                <td className="py-3 px-3">
                  <span className="text-xs text-hud-cream-mute">
                    {p.pipeline?.name || '-'} / {p.stage?.name || '-'}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[p.status] || 'text-hud-cream-dim'}`}>
                    {p.status.replace('_', ' ')}
                  </span>
                </td>
                <td className="py-3 px-3">
                  {p.assigned_user ? (
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-5 rounded-full bg-hud-cream-mute flex items-center justify-center">
                        <span className="text-[9px] text-hud-cream-soft">{p.assigned_user.name?.charAt(0)}</span>
                      </div>
                      <span className="text-xs text-hud-cream-dim truncate max-w-[80px]">{p.assigned_user.name}</span>
                    </div>
                  ) : (
                    <UserIcon className="w-4 h-4 text-hud-cream-mute" />
                  )}
                </td>
                <td className="py-3 px-3">
                  <span className={`text-xs capitalize ${PRIORITY_STYLES[p.priority]}`}>{p.priority}</span>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2">
                    <div className="w-16 bg-hud-bg-elev rounded-full h-1.5">
                      <div className="h-full bg-hud-gold rounded-full" style={{ width: `${p.progress_percent}%` }} />
                    </div>
                    <span className="text-xs text-hud-cream-mute tabular-nums">{p.progress_percent}%</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-right text-sm text-hud-cream-soft tabular-nums">
                  {Number(p.budget_amount) > 0 ? `$${Number(p.budget_amount).toLocaleString()}` : '-'}
                </td>
                <td className="py-3 px-3 text-sm text-hud-cream-dim">
                  {p.target_end_date ? new Date(p.target_end_date).toLocaleDateString() : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="flex-none px-6 py-3 border-t border-hud-bg-elev flex items-center justify-between">
        <span className="text-sm text-hud-cream-dim">
          {totalCount > 0 ? `Showing ${from} - ${to} of ${totalCount}` : 'No results'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-sm bg-hud-bg-card text-hud-cream-soft rounded-lg border border-hud-cream-mute hover:bg-hud-bg-elev disabled:opacity-40"
          >
            Previous
          </button>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={to >= totalCount}
            className="px-3 py-1.5 text-sm bg-hud-bg-card text-hud-cream-soft rounded-lg border border-hud-cream-mute hover:bg-hud-bg-elev disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => { setShowCreateModal(false); navigate(`/projects/${id}`); }}
        />
      )}
    </div>
  );
}
