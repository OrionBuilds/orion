import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Filter,
  X,
  ChevronDown,
  AlertTriangle,
  DollarSign,
  FolderKanban,
  CheckCircle2,
  Pause,
  Activity,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import { useSidebar } from '../../contexts/SidebarContext';
import type { ProjectPipeline, ProjectBoardData, ProjectFilters, ProjectStats, ProjectStage } from '../../types';
import { getProjectPipelines } from '../../services/projectPipelines';
import { getBoardData, getProjectStats, moveProjectToStage } from '../../services/projects';
import { KanbanBoard } from '../../components/shared/KanbanBoard';
import { ProjectCard } from '../../components/projects/ProjectCard';
import { CreateProjectModal } from '../../components/projects/CreateProjectModal';

export function Projects() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate = usePermission('projects.create');
  const canMoveStage = usePermission('projects.move_stage');
  const { isMobile } = useSidebar();

  const [pipelines, setPipelines] = useState<ProjectPipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const [boardData, setBoardData] = useState<ProjectBoardData | null>(null);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<ProjectFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    loadPipelines();
  }, [user]);

  useEffect(() => {
    if (selectedPipelineId && user) {
      loadBoard();
    }
  }, [selectedPipelineId, filters, user]);

  async function loadPipelines() {
    if (!user) return;
    try {
      const data = await getProjectPipelines(user.organization_id);
      setPipelines(data);
      if (data.length > 0) {
        setSelectedPipelineId(data[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadBoard() {
    if (!user || !selectedPipelineId) return;
    try {
      const [board, statsData] = await Promise.all([
        getBoardData(user.organization_id, selectedPipelineId, { ...filters, search: searchText || undefined }),
        getProjectStats(user.organization_id, { pipelineId: selectedPipelineId }),
      ]);
      setBoardData(board);
      setStats(statsData);
    } catch (err) {
      console.error(err);
    }
  }

  // Optimistically move the card, then persist; reload the board if the write fails.
  const handleMoveProject = useCallback(async (projectId: string, stageId: string) => {
    if (!user) return;

    setBoardData((prev) => {
      if (!prev) return prev;
      let movedProject: ProjectBoardData['stages'][0]['projects'][0] | null = null;
      const updated = prev.stages.map((s) => ({
        ...s,
        projects: s.projects.filter((p) => {
          if (p.id === projectId) { movedProject = p; return false; }
          return true;
        }),
      }));
      if (!movedProject) return prev;
      return {
        ...prev,
        stages: updated.map((s) =>
          s.id === stageId ? { ...s, projects: [...s.projects, { ...movedProject!, stage_id: stageId }] } : s
        ),
      };
    });

    try {
      await moveProjectToStage(projectId, stageId, user.id);
    } catch (err) {
      console.error(err);
      loadBoard();
    }
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <div className="w-20 h-20 bg-hud-bg-elev/50 rounded-full flex items-center justify-center">
          <FolderKanban className="w-10 h-10 text-hud-cream-mute" />
        </div>
        <h2 className="text-xl font-semibold text-white">No project pipelines yet</h2>
        <p className="text-hud-cream-dim text-sm text-center max-w-md">
          Engineering and SEO (FRIDAY) live under Pipelines.
        </p>
        <button
          onClick={() => navigate('/projects/pipelines')}
          className="px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm"
        >
          Open pipeline manager
        </button>
      </div>
    );
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId) ?? null;

  return (
    <div className="h-full min-w-0 flex flex-col">
      <div className="flex-none px-4 sm:px-6 py-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
            <select
              value={selectedPipelineId}
              onChange={(e) => setSelectedPipelineId(e.target.value)}
              className="bg-hud-bg-card border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold w-full sm:w-auto"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {selectedPipeline?.owner_agent && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded border border-hud-gold/40 bg-hud-gold/15 text-hud-gold-soft text-[10px] font-semibold tracking-wide"
                title={`Managed by ${selectedPipeline.owner_agent.toUpperCase()}`}
              >
                {selectedPipeline.owner_agent.toUpperCase()}
              </span>
            )}
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadBoard()}
              placeholder="Search projects..."
              className="bg-hud-bg-card border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm w-full sm:w-56 focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors touch-manipulation ${
                showFilters
                  ? 'bg-hud-gold-deep text-white'
                  : 'bg-hud-bg-card text-hud-cream-soft border border-hud-cream-mute hover:bg-hud-bg-elev'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filters
            </button>
            {canCreate && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm touch-manipulation"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">New Project</span>
                <span className="sm:hidden">New</span>
              </button>
            )}
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
            <StatPill icon={Activity} label="Total" value={stats.totalProjects} color="text-white" />
            <StatPill icon={CheckCircle2} label="Active" value={stats.activeProjects} color="text-hud-gold-soft" />
            <StatPill icon={CheckCircle2} label="Completed" value={stats.completedProjects} color="text-hud-emerald" />
            <StatPill icon={Pause} label="On Hold" value={stats.onHoldProjects} color="text-hud-rust" />
            <StatPill icon={AlertTriangle} label="Overdue" value={stats.overdueProjects} color="text-hud-plum" />
            <StatPill icon={DollarSign} label="Budget" value={`$${(stats.totalBudget / 1000).toFixed(0)}k`} color="text-hud-emerald" />
          </div>
        )}

        {showFilters && (
          <FilterBar filters={filters} setFilters={setFilters} onClose={() => setShowFilters(false)} onApply={loadBoard} />
        )}
      </div>

      {isMobile ? (
        <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4">
          {boardData?.stages.map((stage) => {
            if (stage.projects.length === 0) return null;
            return (
              <div key={stage.id}>
                <div className="flex items-center gap-2 mb-2">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: stage.color || '#64748b' }}
                  />
                  <h3 className="text-sm font-semibold text-white">{stage.name}</h3>
                  <span className="text-xs text-hud-cream-mute bg-hud-bg-card px-1.5 py-0.5 rounded">
                    {stage.projects.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {stage.projects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      stage={stage}
                      isDragging={false}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {boardData?.stages.every((s) => s.projects.length === 0) && (
            <div className="py-16 text-center">
              <p className="text-hud-cream-mute text-sm">No projects found</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-x-auto px-6 pb-6">
          <KanbanBoard
            stages={boardData?.stages || []}
            getStageId={(stage) => stage.id}
            getItems={(stage) => stage.projects}
            getItemId={(project) => project.id}
            canDragItem={(project) => canMoveStage && project.status === 'active'}
            onMove={handleMoveProject}
            emptyLabel="No projects"
            dropRingClassName="ring-2 ring-hud-gold-soft bg-hud-gold/5"
            columnClassName="rounded-xl"
            listClassName="flex-1 overflow-y-auto space-y-2 px-1"
            renderStageHeader={(stage) => {
              const stageTotal = stage.projects.reduce((sum, p) => sum + Number(p.budget_amount || 0), 0);
              return (
                <div className="flex items-center justify-between px-3 py-2.5 mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: stage.color || '#64748b' }} />
                    <h3 className="text-sm font-medium text-white">{stage.name}</h3>
                    <span className="text-xs text-hud-cream-mute bg-hud-bg-card px-1.5 py-0.5 rounded">
                      {stage.projects.length}
                    </span>
                  </div>
                  {stageTotal > 0 && (
                    <span className="text-xs text-hud-cream-mute">${stageTotal.toLocaleString()}</span>
                  )}
                </div>
              );
            }}
            renderCard={(project, isDragging, stage) => (
              <ProjectCard project={project} stage={stage} isDragging={isDragging} />
            )}
          />
        </div>
      )}

      {showCreateModal && (
        <CreateProjectModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(id) => {
            setShowCreateModal(false);
            navigate(`/projects/${id}`);
          }}
        />
      )}
    </div>
  );
}

function StatPill({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string | number; color: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50">
      <Icon className={`w-4 h-4 ${color}`} />
      <div>
        <p className="text-xs text-hud-cream-mute">{label}</p>
        <p className={`text-sm font-semibold ${color}`}>{value}</p>
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  setFilters,
  onClose,
  onApply,
}: {
  filters: ProjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<ProjectFilters>>;
  onClose: () => void;
  onApply: () => void;
}) {
  const statuses = ['active', 'on_hold', 'completed', 'cancelled'] as const;

  return (
    <div className="flex items-center gap-3 p-3 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50">
      <div className="flex items-center gap-1">
        {statuses.map((s) => {
          const active = filters.status?.includes(s);
          return (
            <button
              key={s}
              onClick={() => {
                const current = filters.status || [];
                const next = active ? current.filter((x) => x !== s) : [...current, s];
                setFilters({ ...filters, status: next.length > 0 ? next : undefined });
              }}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors capitalize ${
                active ? 'bg-hud-gold-deep text-white' : 'bg-hud-bg-elev text-hud-cream-dim hover:bg-hud-cream-mute'
              }`}
            >
              {s.replace('_', ' ')}
            </button>
          );
        })}
      </div>
      <button
        onClick={() => { onApply(); }}
        className="px-3 py-1 text-xs bg-hud-gold-deep text-white rounded-md hover:bg-hud-gold-deep"
      >
        Apply
      </button>
      <button
        onClick={() => { setFilters({}); onClose(); }}
        className="p-1 text-hud-cream-dim hover:text-white rounded"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
