import { useState, useEffect, useCallback, useRef } from 'react';
import { LayoutDashboard, Palette, MessageSquareText, FileText, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useInTabbedModule } from '../../hooks/useInTabbedModule';
import {
  activateBrandKit,
  createBrandKit,
  getActiveBrandKit,
  getBrandKitById,
  getBrandKits,
} from '../../services/brandboard';
import type { BrandKitWithVersion, BrandKitStatus } from '../../types';
import { BrandKitOverviewTab } from '../../components/settings/brandboard/detail/BrandKitOverviewTab';
import { VisualIdentityTab } from '../../components/settings/brandboard/detail/VisualIdentityTab';
import { BrandVoiceTabNew } from '../../components/settings/brandboard/detail/BrandVoiceTabNew';
import { MessagingCopyTab } from '../../components/settings/brandboard/detail/MessagingCopyTab';

type TabId = 'overview' | 'visual' | 'voice' | 'messaging';

const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'visual', label: 'Visual Identity', icon: Palette },
  { id: 'voice', label: 'Brand Voice', icon: MessageSquareText },
  { id: 'messaging', label: 'Messaging & Copy', icon: FileText },
];

function StatusBadge({ status }: { status: BrandKitStatus }) {
  const styles: Record<BrandKitStatus, string> = {
    draft: 'bg-hud-rust/20 text-hud-rust border-hud-rust/30',
    active: 'bg-hud-emerald/20 text-hud-emerald border-hud-emerald/30',
    archived: 'bg-hud-cream-mute/50 text-hud-cream-dim border-hud-cream-mute/30',
  };
  const labels: Record<BrandKitStatus, string> = { draft: 'Draft', active: 'Active', archived: 'Archived' };
  return (
    <span className={`inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full border ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/** Unsaved stand-in shown when the org has no brand kit yet; the first save creates the real one. */
function emptyKit(orgId: string): BrandKitWithVersion {
  const now = new Date().toISOString();
  return {
    id: '',
    org_id: orgId,
    name: 'Brand Kit',
    description: null,
    active: false,
    status: 'draft',
    archived_at: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    latest_version: {
      id: '',
      brand_kit_id: '',
      version_number: 1,
      logos: [],
      colors: {},
      fonts: {},
      imagery_refs: [],
      tone_settings: { formality: 50, friendliness: 50, energy: 50, confidence: 50 },
      voice_descriptors: [],
      voice_examples: { good: [], bad: [] },
      dos: [],
      donts: [],
      elevator_pitch: null,
      value_proposition: null,
      short_tagline: null,
      long_description: null,
      ctas: [],
      ai_enforce_voice: true,
      ai_enforce_terminology: false,
      ai_avoid_restricted: true,
      ai_forbidden_topics: [],
      ai_forbidden_claims: [],
      ai_forbidden_phrases: [],
      ai_fallback_behavior: 'ask_human',
      published_at: null,
      published_by: null,
      created_by: null,
      created_at: now,
    },
  };
}

/**
 * Settings → Organization → Brandboard: the org has ONE brandboard. This tab is the editor for the
 * active kit (or the first non-archived one); with none yet, the first save creates and activates it.
 */
export function BrandboardSettingsPage() {
  const { user, hasPermission } = useAuth();
  const inTabbedModule = useInTabbedModule();
  const orgId = user?.organization_id;
  const [kit, setKit] = useState<BrandKitWithVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  // Tab content remounts after each reload so its form state picks up the saved version.
  const [reloadKey, setReloadKey] = useState(0);
  const creatingRef = useRef<Promise<string> | null>(null);

  const canManage = hasPermission('brandboard.manage');
  const canPublish = hasPermission('brandboard.publish');

  const loadKit = useCallback(async (id?: string) => {
    if (!orgId) return;
    try {
      const found = id
        ? await getBrandKitById(id)
        : (await getActiveBrandKit(orgId)) ?? (await getBrandKits(orgId))[0] ?? null;
      setKit(found ?? emptyKit(orgId));
      setReloadKey((k) => k + 1);
    } catch (error) {
      console.error('Failed to load brand kit:', error);
      setKit(emptyKit(orgId));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    loadKit();
  }, [loadKit]);

  /** The kit's id, creating (and activating) the org's brand kit on the first save. */
  const ensureKitId = useCallback(async (name?: string): Promise<string> => {
    if (kit?.id) return kit.id;
    if (!orgId || !user?.id) throw new Error('Not signed in');
    creatingRef.current ??= (async () => {
      const created = await createBrandKit(orgId, { name: name?.trim() || 'Brand Kit' }, user.id);
      await activateBrandKit(created.id);
      return created.id;
    })();
    try {
      return await creatingRef.current;
    } catch (error) {
      creatingRef.current = null;
      throw error;
    }
  }, [kit?.id, orgId, user?.id]);

  const handleKitUpdate = useCallback(async () => {
    const id = kit?.id || (creatingRef.current ? await creatingRef.current.catch(() => undefined) : undefined);
    await loadKit(id);
  }, [kit?.id, loadKit]);

  if (loading || !kit) {
    return (
      <div className="min-h-full flex items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-hud-gold animate-spin" />
      </div>
    );
  }

  const tabProps = { kit, onUpdate: handleKitUpdate, canManage, ensureKitId };

  return (
    <div className="min-h-full bg-hud-bg-mid">
      {!inTabbedModule && (
        <div className="bg-hud-bg-card border-b border-hud-bg-elev px-6 py-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-gradient-to-br from-hud-gold/20 to-hud-teal/20 rounded-xl border border-hud-gold/30">
              <Palette className="w-7 h-7 text-hud-gold-soft" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-white">Brandboard</h1>
              <p className="text-sm text-hud-cream-dim mt-0.5">Define your brand's visual identity and voice</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-hud-bg-card border border-hud-bg-elev rounded-t-xl">
        <div className="px-6 py-4 flex items-center gap-4">
          <h2 className="text-xl font-semibold text-white">{kit.name}</h2>
          {kit.id ? (
            <>
              <StatusBadge status={kit.status} />
              <span className="text-sm text-hud-cream-dim">v{kit.latest_version?.version_number || 1}</span>
            </>
          ) : (
            <span className="text-sm text-hud-cream-dim">Not saved yet: your first save creates the brandboard.</span>
          )}
        </div>
        <div className="px-6">
          <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Tabs">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`
                    flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                    ${isActive
                      ? 'border-hud-gold text-white'
                      : 'border-transparent text-hud-cream-dim hover:text-hud-cream-soft hover:border-hud-cream-mute'
                    }
                  `}
                >
                  <Icon className="w-4 h-4" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="py-6" key={reloadKey}>
        {activeTab === 'overview' && <BrandKitOverviewTab {...tabProps} canPublish={canPublish} />}
        {activeTab === 'visual' && <VisualIdentityTab {...tabProps} />}
        {activeTab === 'voice' && <BrandVoiceTabNew {...tabProps} />}
        {activeTab === 'messaging' && <MessagingCopyTab {...tabProps} />}
      </div>
    </div>
  );
}
