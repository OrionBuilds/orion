import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Factory as FactoryIcon, RefreshCw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PageHeader } from '../../components/layouts';
import { BoardTab } from '../../components/factory/BoardTab';
import { PlaybooksTab } from '../../components/factory/PlaybooksTab';
import { AutonomyTab } from '../../components/factory/AutonomyTab';
import { RolesTab } from '../../components/factory/RolesTab';

const TABS = [
  { id: 'board', label: 'Board' },
  { id: 'playbooks', label: 'Playbooks' },
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'roles', label: 'Roles' },
];

/**
 * Factory: playbooks that put the agents to work on deals, projects and schedules. The Board shows
 * live runs; Playbooks and Roles are the definitions; Autonomy is where the owner decides, action by
 * action, what the agents may do without asking. Writes are owner-only (factory.manage + RLS).
 */
export function Factory() {
  const { user, hasPermission } = useAuth();
  const orgId = user?.organization_id;
  const canManage = hasPermission('factory.manage');
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'board';
  const [refreshKey, setRefreshKey] = useState(0);

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'board') next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full flex-col p-6">
      <PageHeader
        title="Factory"
        subtitle={canManage ? 'Agent playbooks on deals, projects and schedules' : 'Agent playbooks on deals, projects and schedules · view only'}
        icon={FactoryIcon}
        primaryAction={{ label: 'Refresh', icon: RefreshCw, onClick: () => setRefreshKey((k) => k + 1) }}
      />

      <nav className="mt-4 flex gap-1 overflow-x-auto border-b border-hud-line-soft" aria-label="Factory sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-hud-gold text-hud-cream' : 'border-transparent text-hud-cream-dim hover:text-hud-cream'}`}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex-1 space-y-4 overflow-y-auto pb-6">
        {orgId && user && (
          <>
            {tab === 'board' && <BoardTab canManage={canManage} refreshKey={refreshKey} />}
            {tab === 'playbooks' && <PlaybooksTab orgId={orgId} canManage={canManage} refreshKey={refreshKey} />}
            {tab === 'autonomy' && <AutonomyTab orgId={orgId} userId={user.id} userName={user.name || user.email} canManage={canManage} refreshKey={refreshKey} />}
            {tab === 'roles' && <RolesTab orgId={orgId} canManage={canManage} refreshKey={refreshKey} />}
          </>
        )}
      </div>
    </div>
  );
}

export default Factory;
