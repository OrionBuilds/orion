/**
 * CAIO tab on a project: the Fractional CAIO engagement for this client. Without an engagement it explains
 * what one is and offers the start form. With one: Overview, Company profile, Sources, Inbox, Needs your input, Registers, Documents, Sign-off, Gates and Settings, chosen
 * by `?caio=` (and `&register=<key>` to open a register). Writes need caio.manage (the database enforces it too).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { usePermission } from '../../hooks/usePermission';
import { supabase } from '../../lib/supabase';
import { getErrorMessage } from '../../lib/errors';
import { getEngagementByProject, type Engagement } from '../../services/caio';
import { ErrorBox } from '../caio/ui';
import { StartEngagement } from '../caio/StartEngagement';
import { OverviewPanel } from '../caio/OverviewPanel';
import { GatesPanel } from '../caio/GatesPanel';
import { SettingsPanel } from '../caio/SettingsPanel';
import { RegistersPanel } from '../caio/RegistersPanel';
import { DocumentsPanel } from '../caio/DocumentsPanel';
import { CompanyProfilePanel } from '../caio/CompanyProfilePanel';
import { SourcesPanel } from '../caio/SourcesPanel';
import { InboxPanel } from '../caio/InboxPanel';
import { NeedsInputPanel } from '../caio/NeedsInputPanel';
import { SignOffQueue } from '../caio/SignOffQueue';
import type { AnyNavigate, AnySubTab } from '../caio/automationLogic';

const SUB_TABS: { id: AnySubTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'profile', label: 'Company profile' },
  { id: 'sources', label: 'Sources' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'needs', label: 'Needs your input' },
  { id: 'registers', label: 'Registers' },
  { id: 'documents', label: 'Documents' },
  { id: 'signoff', label: 'Sign-off' },
  { id: 'gates', label: 'Gates' },
  { id: 'settings', label: 'Settings' },
];

/** The company of the project's contact, to prefill the client's legal name. Best effort: blank on any failure. */
async function contactCompany(projectId: string): Promise<string> {
  const { data } = await supabase.from('projects').select('contact:contacts(company)').eq('id', projectId).maybeSingle();
  const c = (data as { contact?: { company?: string | null } | { company?: string | null }[] | null } | null)?.contact;
  const one = Array.isArray(c) ? c[0] : c;
  return one?.company?.trim() ?? '';
}

export function ProjectCaioTab({ projectId }: { projectId: string }) {
  const canManage = usePermission('caio.manage');
  const [params, setParams] = useSearchParams();
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [company, setCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const e = await getEngagementByProject(projectId);
      setEngagement(e);
      if (!e) setCompany(await contactCompany(projectId).catch(() => ''));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load the CAIO engagement'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const raw = params.get('caio');
  const sub: AnySubTab = SUB_TABS.some((t) => t.id === raw) ? (raw as AnySubTab) : 'overview';
  const register = params.get('register') ?? undefined;

  const go: AnyNavigate = (tab, opts) => {
    const next = new URLSearchParams(params);
    if (tab === 'overview') next.delete('caio'); else next.set('caio', tab);
    if (opts?.register) next.set('register', opts.register); else next.delete('register');
    setParams(next, { replace: true });
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-hud-gold" aria-label="Loading" /></div>;
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>;
  if (!engagement) {
    return <StartEngagement projectId={projectId} defaultClientName={company} canManage={canManage} onStarted={() => { setLoading(true); void load(); }} />;
  }

  return (
    <div className="space-y-4 p-6">
      <nav className="flex gap-1 overflow-x-auto border-b border-hud-line-soft" aria-label="CAIO sections">
        {SUB_TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => go(t.id)} aria-current={sub === t.id ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${sub === t.id ? 'border-hud-gold text-hud-cream' : 'border-transparent text-hud-cream-dim hover:text-hud-cream'}`}>
            {t.label}
          </button>
        ))}
      </nav>
      {sub === 'overview' && <OverviewPanel engagement={engagement} onNavigate={go} canManage={canManage} />}
      {sub === 'profile' && <CompanyProfilePanel engagement={engagement} canManage={canManage} />}
      {sub === 'sources' && <SourcesPanel engagement={engagement} canManage={canManage} />}
      {sub === 'inbox' && <InboxPanel engagement={engagement} canManage={canManage} />}
      {sub === 'needs' && <NeedsInputPanel engagement={engagement} canManage={canManage} onNavigate={go} />}
      {sub === 'signoff' && <SignOffQueue engagement={engagement} canManage={canManage} />}
      {sub === 'registers' && <RegistersPanel engagement={engagement} canManage={canManage} initialRegister={register} />}
      {sub === 'documents' && <DocumentsPanel engagement={engagement} canManage={canManage} />}
      {sub === 'gates' && <GatesPanel engagement={engagement} canManage={canManage} onNavigate={go} />}
      {sub === 'settings' && <SettingsPanel engagement={engagement} canManage={canManage} onSaved={(e) => setEngagement(e)} />}
    </div>
  );
}

export default ProjectCaioTab;
