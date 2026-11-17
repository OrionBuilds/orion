import { useState, useEffect, useRef } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Target,
  Plus,
  Settings,
  List,
  LayoutGrid,
  ChevronDown,
  DollarSign,
  RefreshCw,
  Filter,
  ArrowUpDown,
  BarChart3
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import { useDevice } from '../../contexts/DeviceContext';
import type {
  Pipeline,
  Opportunity,
  OpportunityFilters,
  OpportunityBoardData,
  OpportunityStats,
  User,
  Department
} from '../../types';
import * as pipelinesService from '../../services/pipelines';
import * as opportunitiesService from '../../services/opportunities';
import { getUsers } from '../../services/users';
import { getDepartments } from '../../services/departments';
import { PipelineManageModal } from '../../components/opportunities/PipelineManageModal';
import { OpportunityModal } from '../../components/opportunities/OpportunityModal';
import { KanbanBoard } from '../../components/shared/KanbanBoard';
import { OpportunityCard } from '../../components/opportunities/OpportunityCard';
import { OpportunityFilterPanel } from '../../components/opportunities/OpportunityFilterPanel';
import { PipelineSummaryStrip } from '../../components/opportunities/PipelineSummaryStrip';
import { formatWholeCurrency } from '../../utils/formatters';

type SortOption = 'newest' | 'oldest' | 'highest_value' | 'lowest_value' | 'close_date';

function OpportunitiesBoard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const canManagePipelines = usePermission('pipelines.manage');
  const canCreate = usePermission('opportunities.create');
  const canMoveStage = usePermission('opportunities.move_stage');
  // The board needs width: a phone gets the list, a tablet keeps the board.
  const isMobile = useDevice().device === 'phone';

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [boardData, setBoardData] = useState<OpportunityBoardData | null>(null);
  const [stats, setStats] = useState<OpportunityStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<OpportunityFilters>({});

  const [showPipelineDropdown, setShowPipelineDropdown] = useState(false);
  const [showManagePipelines, setShowManagePipelines] = useState(false);
  const [showOpportunityModal, setShowOpportunityModal] = useState(false);
  const [selectedStageForNew, setSelectedStageForNew] = useState<string | null>(null);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [showTotals, setShowTotals] = useState(true);


  const dropdownRef = useRef<HTMLDivElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);

  // Mobile is pinned to list, not merely defaulted to it. A ?view=board link — bookmarked, or
  // shared from a desktop — would otherwise render the board on a phone with the toggle hidden,
  // leaving no way back to a usable view. The board cannot be operated by touch at all, so there
  // is no case where honouring that parameter on mobile is right.
  const requestedView = searchParams.get('view') || (isMobile ? 'list' : 'board');
  const viewMode = isMobile ? 'list' : requestedView;

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: 'newest', label: 'Newest First' },
    { value: 'oldest', label: 'Oldest First' },
    { value: 'highest_value', label: 'Highest Value' },
    { value: 'lowest_value', label: 'Lowest Value' },
    { value: 'close_date', label: 'Close Date' }
  ];

  const activeFilterCount = [
    filters.status?.length,
    filters.assignedUserId !== undefined ? 1 : 0,
    filters.departmentId ? 1 : 0,
    filters.stageId ? 1 : 0,
    filters.minValue !== undefined ? 1 : 0,
    filters.maxValue !== undefined ? 1 : 0,
    filters.createdAfter ? 1 : 0,
    filters.createdBefore ? 1 : 0,
    filters.tagIds?.length,
    filters.search ? 1 : 0
  ].reduce((a: number, b) => a + (b || 0), 0);

  useEffect(() => {
    if (user?.organization_id) {
      loadInitialData();
    }
  }, [user?.organization_id]);

  useEffect(() => {
    if (selectedPipeline) {
      loadBoardData();
      loadStats();
    }
  }, [selectedPipeline?.id, filters]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowPipelineDropdown(false);
      }
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node)) {
        setShowSortDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadInitialData() {
    if (!user?.organization_id) return;
    try {
      const [pipelinesData, usersData, departmentsData] = await Promise.all([
        pipelinesService.getPipelines(),
        getUsers(),
        getDepartments(user.organization_id)
      ]);
      setPipelines(pipelinesData);
      setUsers(usersData);
      setDepartments(departmentsData);

      if (pipelinesData.length > 0) {
        const pipelineId = searchParams.get('pipeline');
        // Fall back to the first pipeline when the one in the URL no longer exists (deleted).
        const pipeline = (pipelineId && pipelinesData.find(p => p.id === pipelineId)) || pipelinesData[0];
        setSelectedPipeline(pipeline);
      } else {
        setSelectedPipeline(null);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadBoardData() {
    if (!selectedPipeline) return;
    try {
      const data = await opportunitiesService.getBoardData(selectedPipeline.id, filters);
      setBoardData(sortBoardData(data, sortBy));
    } catch (error) {
      console.error('Failed to load board data:', error);
    }
  }

  async function loadStats() {
    if (!selectedPipeline) return;
    try {
      const statsData = await opportunitiesService.getOpportunityStats(selectedPipeline.id);
      setStats(statsData);
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  }

  function sortBoardData(data: OpportunityBoardData, sort: SortOption): OpportunityBoardData {
    const sortFn = (a: Opportunity, b: Opportunity) => {
      switch (sort) {
        case 'newest':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'oldest':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'highest_value':
          return Number(b.value_amount) - Number(a.value_amount);
        case 'lowest_value':
          return Number(a.value_amount) - Number(b.value_amount);
        case 'close_date':
          if (!a.close_date && !b.close_date) return 0;
          if (!a.close_date) return 1;
          if (!b.close_date) return -1;
          return new Date(a.close_date).getTime() - new Date(b.close_date).getTime();
        default:
          return 0;
      }
    };

    return {
      ...data,
      stages: data.stages.map(stage => ({
        ...stage,
        opportunities: [...stage.opportunities].sort(sortFn)
      }))
    };
  }

  function handleSortChange(sort: SortOption) {
    setSortBy(sort);
    if (boardData) {
      setBoardData(sortBoardData(boardData, sort));
    }
    setShowSortDropdown(false);
  }

  function handlePipelineSelect(pipeline: Pipeline) {
    setSelectedPipeline(pipeline);
    setSearchParams({ pipeline: pipeline.id, view: viewMode });
    setShowPipelineDropdown(false);
  }

  function handleViewChange(view: 'board' | 'list') {
    if (view === 'list') {
      navigate(`/opportunities/list${selectedPipeline ? `?pipeline=${selectedPipeline.id}` : ''}`);
    } else {
      setSearchParams({
        pipeline: selectedPipeline?.id || '',
        view
      });
    }
  }

  function openNewOpportunityModal(stageId?: string) {
    setSelectedStageForNew(stageId || null);
    setShowOpportunityModal(true);
  }

  function openOpportunityDetail(opportunity: Opportunity) {
    navigate(`/opportunities/${opportunity.id}`);
  }

  function handleOpportunitySaved() {
    setShowOpportunityModal(false);
    setSelectedStageForNew(null);
    loadBoardData();
    loadStats();
  }

  // Optimistically move the card, then persist; reload the board if the write fails.
  async function handleMoveOpportunity(_id: string, stageId: string, opportunity: Opportunity) {
    if (!user || opportunity.stage_id === stageId) return;
    if (opportunity.status !== 'open') return;

    const previousStageId = opportunity.stage_id;

    if (boardData) {
      const updatedStages = boardData.stages.map(stage => {
        if (stage.id === previousStageId) {
          return { ...stage, opportunities: stage.opportunities.filter(o => o.id !== opportunity.id) };
        }
        if (stage.id === stageId) {
          return { ...stage, opportunities: [...stage.opportunities, { ...opportunity, stage_id: stageId }] };
        }
        return stage;
      });
      setBoardData({ ...boardData, stages: updatedStages });
    }

    try {
      await opportunitiesService.moveOpportunityToStage(opportunity.id, stageId, user.id);
    } catch (error) {
      console.error('Failed to move opportunity:', error);
      loadBoardData();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-hud-gold-soft border-t-transparent rounded-full" />
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-center">
        <div className="w-16 h-16 rounded-full bg-hud-bg-elev flex items-center justify-center mb-4">
          <Target className="w-8 h-8 text-hud-cream-dim" />
        </div>
        <h2 className="text-xl font-semibold text-white mb-2">No Pipelines Yet</h2>
        <p className="text-hud-cream-dim mb-6 max-w-md">
          Create your first pipeline to start tracking opportunities and managing your sales process.
        </p>
        {canManagePipelines && (
          <button
            onClick={() => setShowManagePipelines(true)}
            className="px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep"
          >
            Create Pipeline
          </button>
        )}
        {showManagePipelines && user && (
          <PipelineManageModal
            orgId={user.organization_id}
            onClose={() => {
              setShowManagePipelines(false);
              loadInitialData();
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full min-w-0 flex flex-col">
      <div className="flex-none p-3 sm:p-4 border-b border-hud-bg-elev">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowPipelineDropdown(!showPipelineDropdown)}
                className="flex items-center gap-2 px-4 py-2 bg-hud-bg-elev rounded-lg text-white hover:bg-hud-cream-mute"
              >
                <Target className="w-4 h-4 text-hud-gold-soft" />
                <span className="font-medium">{selectedPipeline?.name || 'Select Pipeline'}</span>
                <ChevronDown className="w-4 h-4" />
              </button>
              {showPipelineDropdown && (
                <div className="absolute z-30 top-full left-0 mt-1 w-64 bg-hud-bg-elev border border-hud-cream-mute rounded-lg shadow-xl">
                  {pipelines.map(pipeline => (
                    <button
                      key={pipeline.id}
                      onClick={() => handlePipelineSelect(pipeline)}
                      className={`w-full px-4 py-2 text-left hover:bg-hud-cream-mute first:rounded-t-lg last:rounded-b-lg ${
                        selectedPipeline?.id === pipeline.id ? 'bg-hud-gold/20 text-hud-gold-soft' : 'text-white'
                      }`}
                    >
                      {pipeline.name}
                    </button>
                  ))}
                  {canManagePipelines && (
                    <>
                      <div className="border-t border-hud-cream-mute" />
                      <button
                        onClick={() => {
                          setShowPipelineDropdown(false);
                          setShowManagePipelines(true);
                        }}
                        className="w-full px-4 py-2 text-left text-hud-cream-dim hover:bg-hud-cream-mute hover:text-white rounded-b-lg flex items-center gap-2"
                      >
                        <Settings className="w-4 h-4" />
                        Manage Pipelines
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/*
              The whole toggle is hidden on mobile, not just styled down. KanbanBoard is HTML5
              drag-and-drop only, and touch does not synthesise dragstart — so on a phone the board
              renders but cards cannot be moved at all. Offering a view that silently does nothing
              is worse than not offering it.

              Nothing is lost by hiding it: viewMode already defaults to 'list' on mobile (:72),
              and an opportunity's stage can still be changed from the detail page's stage select.
              Building touch DnD is the real fix and is not this change.
            */}
            <div className="hidden md:flex items-center bg-hud-bg-elev rounded-lg p-1">
              <button
                onClick={() => handleViewChange('board')}
                className={`px-3 py-1.5 rounded flex items-center gap-2 text-sm ${
                  viewMode === 'board'
                    ? 'bg-hud-cream-mute text-white'
                    : 'text-hud-cream-dim hover:text-white'
                }`}
              >
                <LayoutGrid className="w-4 h-4" />
                Board
              </button>
              <button
                onClick={() => handleViewChange('list')}
                className={`px-3 py-1.5 rounded flex items-center gap-2 text-sm ${
                  viewMode === 'list'
                    ? 'bg-hud-cream-mute text-white'
                    : 'text-hud-cream-dim hover:text-white'
                }`}
              >
                <List className="w-4 h-4" />
                List
              </button>
            </div>

            <button
              onClick={() => setShowFilterPanel(true)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                activeFilterCount > 0
                  ? 'bg-hud-gold/20 border-hud-gold/50 text-hud-gold-soft'
                  : 'bg-hud-bg-elev border-hud-cream-mute text-hud-cream-soft hover:bg-hud-cream-mute'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="px-1.5 py-0.5 bg-hud-gold text-hud-bg-deep text-xs rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </button>

            <div className="relative" ref={sortDropdownRef}>
              <button
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-2 px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-hud-cream-soft hover:bg-hud-cream-mute"
              >
                <ArrowUpDown className="w-4 h-4" />
                Sort
              </button>
              {showSortDropdown && (
                <div className="absolute z-30 top-full left-0 mt-1 w-48 bg-hud-bg-elev border border-hud-cream-mute rounded-lg shadow-xl">
                  {sortOptions.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleSortChange(opt.value)}
                      className={`w-full px-4 py-2 text-left text-sm hover:bg-hud-cream-mute first:rounded-t-lg last:rounded-b-lg ${
                        sortBy === opt.value ? 'bg-hud-gold/20 text-hud-gold-soft' : 'text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={() => setShowTotals(!showTotals)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                showTotals
                  ? 'bg-hud-rust/20 border-hud-rust/50 text-hud-rust'
                  : 'bg-hud-bg-elev border-hud-cream-mute text-hud-cream-soft hover:bg-hud-cream-mute'
              }`}
              title="Toggle pipeline totals"
            >
              <BarChart3 className="w-4 h-4" />
            </button>

            <button
              onClick={() => {
                loadBoardData();
                loadStats();
              }}
              className="p-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {canManagePipelines && (
              <button
                onClick={() => setShowManagePipelines(true)}
                className="flex items-center gap-2 px-3 py-2 text-hud-cream-soft hover:bg-hud-bg-elev rounded-lg"
              >
                <Settings className="w-4 h-4" />
                Manage
              </button>
            )}
            {canCreate && (
              <button
                onClick={() => openNewOpportunityModal()}
                className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep"
              >
                <Plus className="w-4 h-4" />
                New Opportunity
              </button>
            )}
          </div>
        </div>
      </div>

      {stats && <PipelineSummaryStrip stats={stats} isVisible={showTotals} />}

      {viewMode === 'board' && boardData && (
        <div className="flex-1 min-h-0 overflow-x-auto p-4">
          <KanbanBoard
            stages={boardData.stages}
            getStageId={(stage) => stage.id}
            getItems={(stage) => stage.opportunities}
            getItemId={(opportunity) => opportunity.id}
            canDragItem={(opportunity) => opportunity.status === 'open' && canMoveStage}
            onMove={handleMoveOpportunity}
            columnClassName="bg-hud-bg-card/50 rounded-lg"
            renderStageHeader={(stage) => {
              const stageValue = stage.opportunities.reduce((sum, o) => sum + Number(o.value_amount), 0);
              return (
                <div className="flex-none p-3 border-b border-hud-bg-elev">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="font-medium text-white">{stage.name}</h3>
                    <span className="text-sm text-hud-cream-dim">{stage.opportunities.length}</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm text-hud-emerald">
                    <DollarSign className="w-3.5 h-3.5" />
                    {formatWholeCurrency(stageValue)}
                  </div>
                </div>
              );
            }}
            renderCard={(opportunity, isDragging, stage) => (
              <OpportunityCard
                opportunity={opportunity}
                onClick={() => openOpportunityDetail(opportunity)}
                isDragging={isDragging}
                stage={stage}
                canDrag={canMoveStage}
              />
            )}
            renderStageFooter={(stage) =>
              canCreate ? (
                <div className="flex-none p-2 border-t border-hud-bg-elev">
                  <button
                    onClick={() => openNewOpportunityModal(stage.id)}
                    className="w-full flex items-center justify-center gap-2 py-2 text-hud-cream-dim hover:text-white hover:bg-hud-bg-elev rounded"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              ) : null
            }
          />
        </div>
      )}

      <OpportunityFilterPanel
        isOpen={showFilterPanel}
        filters={filters}
        users={users}
        departments={departments}
        stages={boardData?.stages || []}
        onFilterChange={(newFilters) => {
          setFilters(newFilters);
          setShowFilterPanel(false);
        }}
        onClose={() => setShowFilterPanel(false)}
      />

      {showManagePipelines && user && (
        <PipelineManageModal
          orgId={user.organization_id}
          onClose={() => {
            setShowManagePipelines(false);
            loadInitialData();
          }}
          onPipelineSelect={(pipeline) => {
            handlePipelineSelect(pipeline);
          }}
        />
      )}

      {showOpportunityModal && user && selectedPipeline && (
        <OpportunityModal
          pipeline={selectedPipeline}
          preselectedStageId={selectedStageForNew}
          orgId={user.organization_id}
          currentUser={user}
          onClose={() => {
            setShowOpportunityModal(false);
            setSelectedStageForNew(null);
          }}
          onSave={handleOpportunitySaved}
        />
      )}
    </div>
  );
}

/** A phone cannot use a kanban board: send it to the list view, the same page the "list" route serves. */
export function Opportunities() {
  const { device } = useDevice();
  if (device === 'phone') return <Navigate to="/opportunities/list" replace />;
  return <OpportunitiesBoard />;
}
