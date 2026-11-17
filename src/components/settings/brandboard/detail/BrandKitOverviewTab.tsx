import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Rocket, Save } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { updateBrandKit, activateBrandKit, publishBrandKit, setActiveBrandKit } from '../../../../services/brandboard';
import type { BrandKitWithVersion, BrandKitStatus } from '../../../../types';

interface BrandKitOverviewTabProps {
  kit: BrandKitWithVersion;
  onUpdate: () => void;
  /** Id of the kit to save into; creates the org's brand kit on the first save. */
  ensureKitId: (name?: string) => Promise<string>;
  canManage: boolean;
  canPublish: boolean;
}

function StatusBadge({ status }: { status: BrandKitStatus }) {
  const styles: Record<BrandKitStatus, string> = {
    draft: 'bg-hud-rust/20 text-hud-rust border-hud-rust/30',
    active: 'bg-hud-emerald/20 text-hud-emerald border-hud-emerald/30',
    archived: 'bg-hud-cream-mute/50 text-hud-cream-dim border-hud-cream-mute/30',
  };

  const labels: Record<BrandKitStatus, string> = {
    draft: 'Draft',
    active: 'Active',
    archived: 'Archived',
  };

  return (
    <span className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg border ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export function BrandKitOverviewTab({ kit, onUpdate, canManage, ensureKitId, canPublish }: BrandKitOverviewTabProps) {
  const { user } = useAuth();
  const [name, setName] = useState(kit.name);
  const [description, setDescription] = useState(kit.description || '');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [activating, setActivating] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const handleNameChange = (value: string) => {
    setName(value);
    setHasChanges(value !== kit.name || description !== (kit.description || ''));
  };

  const handleDescriptionChange = (value: string) => {
    setDescription(value);
    setHasChanges(name !== kit.name || value !== (kit.description || ''));
  };

  const handleSave = async () => {
    if (!user?.id) return;
    setSaving(true);
    try {
      await updateBrandKit(await ensureKitId(name), { name, description: description || undefined }, user.id);
      setHasChanges(false);
      onUpdate();
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!user?.id) return;
    if (!window.confirm('Publishing this brand will affect AI outputs, proposals, emails, and invoices across your organization. Continue?')) return;
    setPublishing(true);
    try {
      await publishBrandKit(kit.id, user.id);
      onUpdate();
    } catch (error) {
      console.error('Failed to publish:', error);
    } finally {
      setPublishing(false);
    }
  };

  const handleSetActive = async () => {
    if (!window.confirm('Setting this brand as active will deactivate any currently active brand. Continue?')) return;
    setActivating(true);
    try {
      await setActiveBrandKit(kit.id);
      onUpdate();
    } catch (error) {
      console.error('Failed to activate:', error);
    } finally {
      setActivating(false);
    }
  };

  // One brandboard per org: the kit stays editable while active (each save is a new version).
  const isEditable = kit.status !== 'archived' && canManage;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
        <h2 className="text-lg font-semibold text-white mb-6">Brand Kit Details</h2>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Brand Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              disabled={!isEditable}
              className="w-full px-4 py-2.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed"
              placeholder="Enter brand name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              disabled={!isEditable}
              rows={3}
              className="w-full px-4 py-2.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed resize-none"
              placeholder="Describe this brand kit"
            />
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <label className="block text-sm font-medium text-hud-cream-dim mb-1">Current Status</label>
              <StatusBadge status={kit.status} />
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-cream-dim mb-1">Version Number</label>
              <span className="text-lg font-semibold text-white">v{kit.latest_version?.version_number || 1}</span>
            </div>
          </div>
        </div>

        {hasChanges && isEditable && (
          <div className="mt-6 pt-6 border-t border-hud-bg-elev flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-hud-gold-deep text-white text-sm font-medium rounded-lg hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>

      {kit.id && kit.status !== 'archived' && (
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Actions</h2>

          <div className="bg-hud-rust/10 border border-hud-rust/30 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-hud-rust flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-hud-rust/25 font-medium">Publishing affects system-wide content</p>
                <p className="text-sm text-hud-rust/80 mt-1">
                  Setting this brand as active will affect AI outputs, proposals, emails, and invoices across your organization.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {canPublish && kit.status === 'draft' && (
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-hud-gold to-hud-teal text-white text-sm font-medium rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50 shadow-lg shadow-hud-gold/20"
              >
                <Rocket className="w-4 h-4" />
                {publishing ? 'Publishing...' : 'Publish Version'}
              </button>
            )}

            {canPublish && kit.status !== 'active' && (
              <button
                onClick={handleSetActive}
                disabled={activating}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-hud-emerald-dim text-white hover:text-hud-bg-deep text-sm font-medium rounded-lg hover:bg-hud-emerald transition-colors disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                {activating ? 'Activating...' : 'Set as Active'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Metadata</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-hud-cream-dim">Created by</span>
            <p className="text-white mt-1">{kit.created_by_user?.name || 'Unknown'}</p>
          </div>
          <div>
            <span className="text-hud-cream-dim">Created at</span>
            <p className="text-white mt-1">{new Date(kit.created_at).toLocaleDateString()}</p>
          </div>
          <div>
            <span className="text-hud-cream-dim">Last updated</span>
            <p className="text-white mt-1">{new Date(kit.updated_at).toLocaleDateString()}</p>
          </div>
          {kit.latest_version?.published_at && (
            <div>
              <span className="text-hud-cream-dim">Last published</span>
              <p className="text-white mt-1">{new Date(kit.latest_version.published_at).toLocaleDateString()}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
