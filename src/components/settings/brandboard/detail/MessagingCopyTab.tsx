import { useState } from 'react';
import { Plus, X, Save, Megaphone, FileText, MousePointer } from 'lucide-react';
import { useAuth } from '../../../../contexts/AuthContext';
import { updateBrandKitMessaging } from '../../../../services/brandboard';
import type { BrandKitWithVersion, BrandCTA } from '../../../../types';

interface MessagingCopyTabProps {
  kit: BrandKitWithVersion;
  onUpdate: () => void;
  /** Id of the kit to save into; creates the org's brand kit on the first save. */
  ensureKitId: (name?: string) => Promise<string>;
  canManage: boolean;
}

export function MessagingCopyTab({ kit, onUpdate, canManage, ensureKitId }: MessagingCopyTabProps) {
  const { user } = useAuth();
  const v = kit.latest_version;

  const [elevatorPitch, setElevatorPitch] = useState(v?.elevator_pitch || '');
  const [valueProposition, setValueProposition] = useState(v?.value_proposition || '');
  const [shortTagline, setShortTagline] = useState(v?.short_tagline || '');
  const [longDescription, setLongDescription] = useState(v?.long_description || '');
  const [ctas, setCtas] = useState<BrandCTA[]>(v?.ctas || []);
  const [showCtaForm, setShowCtaForm] = useState(false);
  const [newCta, setNewCta] = useState<BrandCTA>({ text: '', context: '', placement: '' });
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // One brandboard per org: the kit stays editable while active (each save is a new version).
  const isEditable = kit.status !== 'archived' && canManage;

  const handleFieldChange = (setter: (value: string) => void, value: string) => {
    setter(value);
    setHasChanges(true);
  };

  const handleAddCta = () => {
    if (!newCta.text.trim()) return;
    setCtas((prev) => [...prev, newCta]);
    setNewCta({ text: '', context: '', placement: '' });
    setShowCtaForm(false);
    setHasChanges(true);
  };

  const handleRemoveCta = (index: number) => {
    setCtas((prev) => prev.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!user?.id) return;
    setSaving(true);
    try {
      await updateBrandKitMessaging(await ensureKitId(), {
        elevator_pitch: elevatorPitch || null,
        value_proposition: valueProposition || null,
        short_tagline: shortTagline || null,
        long_description: longDescription || null,
        ctas,
      }, user.id);
      setHasChanges(false);
      onUpdate();
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-hud-gold/20 rounded-lg">
            <Megaphone className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Core Messaging</h2>
            <p className="text-sm text-hud-cream-dim">Your brand's key messages and positioning</p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Elevator Pitch
              <span className="text-hud-cream-mute font-normal ml-2">(~150 characters)</span>
            </label>
            <textarea
              value={elevatorPitch}
              onChange={(e) => handleFieldChange(setElevatorPitch, e.target.value)}
              disabled={!isEditable}
              rows={2}
              maxLength={200}
              placeholder="A concise description of what you do and why it matters..."
              className="w-full px-4 py-3 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed resize-none"
            />
            <div className="text-xs text-hud-cream-mute mt-1 text-right">{elevatorPitch.length}/200</div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Value Proposition</label>
            <textarea
              value={valueProposition}
              onChange={(e) => handleFieldChange(setValueProposition, e.target.value)}
              disabled={!isEditable}
              rows={3}
              placeholder="The unique value you provide to customers..."
              className="w-full px-4 py-3 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed resize-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Short Tagline</label>
            <input
              type="text"
              value={shortTagline}
              onChange={(e) => handleFieldChange(setShortTagline, e.target.value)}
              disabled={!isEditable}
              placeholder="Your memorable brand tagline..."
              className="w-full px-4 py-2.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>
        </div>
      </div>

      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-hud-gold/20 rounded-lg">
            <FileText className="w-5 h-5 text-hud-gold-soft" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Long-Form Description</h2>
            <p className="text-sm text-hud-cream-dim">Detailed brand description for about pages, bios, etc.</p>
          </div>
        </div>

        <textarea
          value={longDescription}
          onChange={(e) => handleFieldChange(setLongDescription, e.target.value)}
          disabled={!isEditable}
          rows={6}
          placeholder="A comprehensive description of your brand, mission, and values..."
          className="w-full px-4 py-3 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold disabled:opacity-60 disabled:cursor-not-allowed resize-none"
        />
        <p className="text-xs text-hud-cream-mute mt-2">Supports markdown formatting</p>
      </div>

      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-hud-gold/20 rounded-lg">
              <MousePointer className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">CTA Library</h2>
              <p className="text-sm text-hud-cream-dim">Call-to-action phrases for different contexts</p>
            </div>
          </div>
          {isEditable && !showCtaForm && (
            <button
              onClick={() => setShowCtaForm(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-hud-bg-elev text-white text-sm font-medium rounded-lg hover:bg-hud-cream-mute transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add CTA
            </button>
          )}
        </div>

        {showCtaForm && (
          <div className="mb-6 p-4 bg-hud-bg-mid/50 rounded-lg border border-hud-bg-elev">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs text-hud-cream-dim mb-1">CTA Text</label>
                <input
                  type="text"
                  value={newCta.text}
                  onChange={(e) => setNewCta((prev) => ({ ...prev, text: e.target.value }))}
                  placeholder="e.g., Get Started"
                  className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold"
                />
              </div>
              <div>
                <label className="block text-xs text-hud-cream-dim mb-1">Context</label>
                <input
                  type="text"
                  value={newCta.context}
                  onChange={(e) => setNewCta((prev) => ({ ...prev, context: e.target.value }))}
                  placeholder="e.g., After pricing section"
                  className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold"
                />
              </div>
              <div>
                <label className="block text-xs text-hud-cream-dim mb-1">Placement</label>
                <input
                  type="text"
                  value={newCta.placement}
                  onChange={(e) => setNewCta((prev) => ({ ...prev, placement: e.target.value }))}
                  placeholder="e.g., Header, Footer"
                  className="w-full px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowCtaForm(false);
                  setNewCta({ text: '', context: '', placement: '' });
                }}
                className="px-4 py-2 text-hud-cream-dim text-sm font-medium hover:text-hud-cream-soft"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCta}
                disabled={!newCta.text.trim()}
                className="px-4 py-2 bg-hud-gold-deep text-white text-sm font-medium rounded-lg hover:bg-hud-gold-deep transition-colors disabled:opacity-50"
              >
                Add CTA
              </button>
            </div>
          </div>
        )}

        {ctas.length === 0 && !showCtaForm ? (
          <div className="text-center py-8 text-hud-cream-mute">
            <MousePointer className="w-10 h-10 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No CTAs added yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {ctas.map((cta, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-4 bg-hud-bg-mid/50 rounded-lg border border-hud-bg-elev"
              >
                <div className="flex items-center gap-6">
                  <div>
                    <span className="text-white font-medium">"{cta.text}"</span>
                  </div>
                  {cta.context && (
                    <div className="text-sm">
                      <span className="text-hud-cream-mute">Context:</span>
                      <span className="text-hud-cream-soft ml-1">{cta.context}</span>
                    </div>
                  )}
                  {cta.placement && (
                    <div className="text-sm">
                      <span className="text-hud-cream-mute">Placement:</span>
                      <span className="text-hud-cream-soft ml-1">{cta.placement}</span>
                    </div>
                  )}
                </div>
                {isEditable && (
                  <button
                    onClick={() => handleRemoveCta(idx)}
                    className="p-1.5 text-hud-cream-mute hover:text-hud-plum transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {hasChanges && isEditable && (
        <div className="flex justify-end sticky bottom-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-hud-gold to-hud-teal text-white text-sm font-medium rounded-lg hover:from-hud-gold-deep hover:to-hud-teal transition-all disabled:opacity-50 shadow-lg shadow-hud-gold/20"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Messaging'}
          </button>
        </div>
      )}
    </div>
  );
}
