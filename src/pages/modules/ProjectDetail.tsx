import { useState, useEffect } from 'react';
import { DetailPageShell } from '../../components/shared/DetailPageShell';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  Pause,
  XCircle,
  RotateCcw,
  Trash2,
  Target,
  FileText,
  Users,
  DollarSign,
  Lock,
  Mail,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import { usePaymentsAccess } from '../../hooks/usePaymentsAccess';
import type { Project, User } from '../../types';
import { getProjectById, updateProject, closeProject, deleteProject } from '../../services/projects';
import { getUsers } from '../../services/users';
import { ProjectOverviewTab } from '../../components/projects/ProjectOverviewTab';
import { ProjectTasksTab } from '../../components/projects/ProjectTasksTab';
import { ProjectNotesTab } from '../../components/projects/ProjectNotesTab';
import { ProjectTimelineTab } from '../../components/projects/ProjectTimelineTab';
import { ProjectFinancialsTab } from '../../components/projects/ProjectFinancialsTab';
import { ProjectChangeRequestsTab } from '../../components/projects/ProjectChangeRequestsTab';
import { ProjectSupportTicketsTab } from '../../components/projects/ProjectSupportTicketsTab';
import { ProjectKnowledgeTab } from '../../components/projects/ProjectKnowledgeTab';
import { ProjectCaioTab } from '../../components/projects/ProjectCaioTab';
import { getEngagementByProject } from '../../services/caio';
import { canViewProjectKnowledge } from '../../services/projectKnowledge';
import { sendPortalInvite } from '../../services/clientPortal';
import { ProjectPortalAccessCard } from '../../components/projects/ProjectPortalAccessCard';
import { ProjectConnectionsCard } from '../../components/projects/ProjectConnectionsCard';
import { ProjectContactCard } from '../../components/projects/ProjectContactCard';
import { ReferencesPanel } from '../../components/shared/ReferencesPanel';

type TabId = 'overview' | 'tasks' | 'notes' | 'timeline' | 'financials' | 'change_requests' | 'support_tickets' | 'knowledge' | 'caio';
const PROJECT_TABS: TabId[] = ['overview', 'tasks', 'notes', 'timeline', 'financials', 'change_requests', 'support_tickets', 'knowledge', 'caio'];

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-hud-emerald/20 text-hud-emerald',
  on_hold: 'bg-hud-rust/20 text-hud-rust',
  completed: 'bg-hud-emerald/20 text-hud-emerald',
  cancelled: 'bg-hud-plum/20 text-hud-plum',
};

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, isFeatureEnabled } = useAuth();
  const canEdit = usePermission('projects.edit');
  const canClose = usePermission('projects.close');
  const canDelete = usePermission('projects.delete');
  const canManageTasks = usePermission('projects.tasks.manage');
  const canViewChangeRequests = usePermission('projects.change_requests.view');
  const canManageChangeRequests = usePermission('projects.change_requests.manage');
  const canApproveChangeRequests = usePermission('projects.change_requests.approve');
  const canAccessPayments = usePaymentsAccess();

  const [project, setProject] = useState<Project | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const t = searchParams.get('tab');
    return t && PROJECT_TABS.includes(t as TabId) ? (t as TabId) : 'overview';
  });
  const [canSeeKnowledge, setCanSeeKnowledge] = useState(false);
  const canViewCaio = usePermission('caio.view');
  const [hasEngagement, setHasEngagement] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [sendingInvite, setSendingInvite] = useState(false);

  useEffect(() => {
    loadProject();
  }, [id, user]);

  // Knowledge notes can describe client code: owner/admin only (the database enforces it too).
  useEffect(() => {
    if (!user) return;
    let live = true;
    canViewProjectKnowledge(user.id).then((ok) => { if (live) setCanSeeKnowledge(ok); });
    return () => { live = false; };
  }, [user]);

  // CAIO tab: shown for projects in the CAIO Engagements pipeline, or any project that already has an engagement.
  useEffect(() => {
    if (!id || !canViewCaio) return;
    let live = true;
    getEngagementByProject(id).then((e) => { if (live) setHasEngagement(!!e); }).catch(() => { if (live) setHasEngagement(false); });
    return () => { live = false; };
  }, [id, canViewCaio]);

  async function loadProject() {
    if (!id || !user) return;
    try {
      const [projectData, usersData] = await Promise.all([
        getProjectById(id),
        getUsers(),
      ]);
      if (!projectData) {
        navigate('/projects');
        return;
      }
      setProject(projectData);
      setUsers(usersData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleClose(status: 'completed' | 'cancelled') {
    if (!project || !user) return;
    const label = status === 'completed' ? 'complete' : 'cancel';
    if (!confirm(`Mark this project as ${label}?`)) return;
    try {
      const updated = await closeProject(project.id, status, user.id);
      setProject(updated);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleReopen() {
    if (!project || !user) return;
    try {
      const updated = await updateProject(project.id, { status: 'active' } as Partial<Project>, user.id);
      setProject(updated);
    } catch (err) {
      console.error(err);
    }
  }

  async function handlePutOnHold() {
    if (!project || !user) return;
    try {
      const updated = await updateProject(project.id, { status: 'on_hold' } as Partial<Project>, user.id);
      setProject(updated);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSendPortalInvite() {
    if (!project || sendingInvite) return;
    setSendingInvite(true);
    try {
      const result = await sendPortalInvite(project.id);
      if (result.skippedReason) {
        alert(`Portal invite skipped: ${result.skippedReason}`);
      } else {
        setInviteSent(true);
        setTimeout(() => setInviteSent(false), 3000);
      }
    } catch (err) {
      alert('Failed to send portal invite. Please try again.');
      console.error(err);
    } finally {
      setSendingInvite(false);
    }
  }

  async function handleDelete() {
    if (!project) return;
    if (!confirm('Permanently delete this project? This cannot be undone.')) return;
    try {
      await deleteProject(project.id);
      navigate('/projects');
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  if (!project) return null;

  const showCaio = canViewCaio && (hasEngagement || project.pipeline?.name === 'CAIO Engagements');
  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'notes', label: 'Notes' },
    { id: 'timeline', label: 'Timeline' },
    ...(canAccessPayments ? [{ id: 'financials' as const, label: 'Financials' }] : []),
    ...(canViewChangeRequests ? [{ id: 'change_requests' as const, label: 'Change Requests' }] : []),
    ...(canViewChangeRequests ? [{ id: 'support_tickets' as const, label: 'Support Tickets' }] : []),
    ...(canSeeKnowledge ? [{ id: 'knowledge' as const, label: 'Knowledge' }] : []),
    ...(showCaio ? [{ id: 'caio' as const, label: 'CAIO' }] : []),
  ];

  return (
    <DetailPageShell
      onBack={() => navigate('/projects')}
      title={project.name}
      badges={
        <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_STYLES[project.status]}`}>
          {project.status.replace('_', ' ')}
        </span>
      }
      subtitle={`${project.pipeline?.name} / ${project.stage?.name}`}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      actions={
        <>
          {project.status === 'active' && canClose && (
            <>
              <button onClick={() => handleClose('completed')} className="flex items-center gap-2 px-3 py-2 bg-hud-emerald-dim text-white hover:text-hud-bg-deep rounded-lg hover:bg-hud-emerald text-sm">
                <CheckCircle2 className="w-4 h-4" /> Complete
              </button>
              <button onClick={handlePutOnHold} className="flex items-center gap-2 px-3 py-2 bg-hud-rust text-hud-bg-deep rounded-lg hover:bg-hud-rust text-sm">
                <Pause className="w-4 h-4" /> Hold
              </button>
              <button onClick={() => handleClose('cancelled')} className="flex items-center gap-2 px-3 py-2 bg-hud-plum text-white rounded-lg hover:bg-hud-plum text-sm">
                <XCircle className="w-4 h-4" /> Cancel
              </button>
            </>
          )}
          {project.status === 'on_hold' && canClose && (
            <button onClick={handleReopen} className="flex items-center gap-2 px-3 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm">
              <RotateCcw className="w-4 h-4" /> Resume
            </button>
          )}
          {(project.status === 'completed' || project.status === 'cancelled') && canClose && (
            <button onClick={handleReopen} className="flex items-center gap-2 px-3 py-2 bg-hud-cream-mute text-white rounded-lg hover:bg-hud-cream-mute text-sm">
              <RotateCcw className="w-4 h-4" /> Reopen
            </button>
          )}
          {canManageChangeRequests && (
            <button
              onClick={handleSendPortalInvite}
              disabled={sendingInvite}
              className="flex items-center gap-2 px-3 py-2 bg-hud-bg-elev hover:bg-hud-cream-mute disabled:opacity-50 text-hud-cream-soft hover:text-white text-sm rounded-lg transition-colors"
            >
              {sendingInvite ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              {inviteSent ? 'Invite Sent!' : 'Send Portal Invite'}
            </button>
          )}
          {canDelete && (
            <button onClick={handleDelete} className="p-2 text-hud-cream-dim hover:text-hud-plum rounded-lg hover:bg-hud-bg-elev">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </>
      }
    >
        <div className="flex-none md:flex-1 min-w-0 md:overflow-y-auto">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <ProjectOverviewTab
                project={project}
                users={users}
                canEdit={canEdit}
                currentUserId={user!.id}
                onUpdate={setProject}
              />
              <ProjectPortalAccessCard
                projectId={project.id}
                orgId={project.org_id}
                canManage={canManageChangeRequests}
                currentUserId={user!.id}
              />
              {isFeatureEnabled('entity_mentions') && (
                <div className="px-6 pb-6">
                  <ReferencesPanel targetType="project" targetId={project.id} />
                </div>
              )}
            </div>
          )}
          {activeTab === 'tasks' && (
            <ProjectTasksTab
              projectId={project.id}
              orgId={project.org_id}
              users={users}
              canManageTasks={canManageTasks}
              currentUserId={user!.id}
            />
          )}
          {activeTab === 'notes' && (
            <ProjectNotesTab
              projectId={project.id}
              orgId={project.org_id}
              canEdit={canEdit}
              currentUserId={user!.id}
            />
          )}
          {activeTab === 'timeline' && (
            <ProjectTimelineTab projectId={project.id} />
          )}
          {activeTab === 'financials' && (
            <ProjectFinancialsTab
              projectId={project.id}
              orgId={project.org_id}
              budgetAmount={Number(project.budget_amount)}
              actualCost={Number(project.actual_cost)}
              currency={project.currency}
              canEdit={canEdit}
              currentUserId={user!.id}
              onCostChange={loadProject}
            />
          )}
          {activeTab === 'change_requests' && (
            <ProjectChangeRequestsTab
              projectId={project.id}
              orgId={project.org_id}
              contactId={project.contact_id}
              users={users}
              canManage={canManageChangeRequests}
              canApprove={canApproveChangeRequests}
              currentUserId={user!.id}
              currentUserName={user!.name || user!.email || ''}
            />
          )}
          {activeTab === 'knowledge' && canSeeKnowledge && <ProjectKnowledgeTab projectId={project.id} />}
          {activeTab === 'caio' && showCaio && <ProjectCaioTab projectId={project.id} />}
          {activeTab === 'support_tickets' && (
            <ProjectSupportTicketsTab
              projectId={project.id}
              orgId={project.org_id}
              users={users}
              canManage={canManageChangeRequests}
              currentUserId={user!.id}
              currentUserName={user!.name || user!.email || ''}
            />
          )}
        </div>

        <div className="flex-none w-full md:w-72 border-t md:border-t-0 md:border-l border-hud-bg-elev md:overflow-y-auto bg-hud-bg-mid/30 p-4 space-y-4">
          {project.contact && (
            <LinkedCard
              icon={Users}
              title="Contact"
              linkTo={`/contacts/${project.contact_id}`}
            >
              {/* BUG FIX (flagged): Contact has first_name/last_name, not `name` — this rendered blank */}
              <p className="text-sm text-white font-medium">{`${project.contact.first_name} ${project.contact.last_name}`.trim()}</p>
              {project.contact.email && <p className="text-xs text-hud-cream-dim truncate">{project.contact.email}</p>}
              {project.contact.phone && <p className="text-xs text-hud-cream-dim">{project.contact.phone}</p>}
            </LinkedCard>
          )}

          {!project.contact_id && <ProjectContactCard project={project} onLinked={setProject} />}

          {project.opportunity && (
            <LinkedCard
              icon={Target}
              title="Opportunity"
              linkTo={`/opportunities/${project.opportunity_id}`}
            >
              <p className="text-sm text-white font-medium truncate">
                {/* BUG FIX (flagged): Contact has first_name/last_name, not `name` — this always showed 'Opportunity' */}
                {(project.opportunity.contact ? `${project.opportunity.contact.first_name} ${project.opportunity.contact.last_name}`.trim() : '') || 'Opportunity'}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                <DollarSign className="w-3 h-3 text-hud-emerald" />
                <span className="text-xs text-hud-emerald">
                  ${Number(project.opportunity.value_amount).toLocaleString()}
                </span>
                {project.opportunity.financial_locked && (
                  <Lock className="w-3 h-3 text-hud-rust ml-1" />
                )}
              </div>
            </LinkedCard>
          )}

          <ProjectConnectionsCard
            project={project}
            canEdit={canEdit}
            currentUserId={user!.id}
            onUpdate={setProject}
          />

          {project.proposal && (
            <LinkedCard
              icon={FileText}
              title="Proposal"
              linkTo={`/proposals/${project.proposal_id}`}
            >
              <p className="text-sm text-white font-medium truncate">{project.proposal.title || 'Proposal'}</p>
              <span className="text-xs text-hud-cream-dim capitalize">{project.proposal.status}</span>
            </LinkedCard>
          )}

          <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-lg p-3">
            <p className="text-xs text-hud-cream-mute mb-2">Quick Info</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-hud-cream-mute">Created</span>
                <span className="text-hud-cream-soft">{new Date(project.created_at).toLocaleDateString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-hud-cream-mute">Progress</span>
                <span className="text-hud-cream-soft">{project.progress_percent}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-hud-cream-mute">Priority</span>
                <span className="text-hud-cream-soft capitalize">{project.priority}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-hud-cream-mute">Risk</span>
                <span className="text-hud-cream-soft capitalize">{project.risk_level}</span>
              </div>
            </div>
          </div>
        </div>
    </DetailPageShell>
  );
}

function LinkedCard({
  icon: Icon,
  title,
  linkTo,
  children,
}: {
  icon: React.ElementType;
  title: string;
  linkTo: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={linkTo}
      className="block bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-lg p-3 hover:border-hud-cream-mute transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-3.5 h-3.5 text-hud-cream-dim" />
        <span className="text-xs text-hud-cream-mute uppercase tracking-wide">{title}</span>
      </div>
      {children}
    </Link>
  );
}
