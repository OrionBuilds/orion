import { useState } from 'react';
import { Loader2, CheckCircle2, ListChecks, Ban, DollarSign, Clock3 } from 'lucide-react';
import type { ContractScopeIndex } from '../../services/contracts';

interface ScopeIndexTabProps {
  scopeIndex: ContractScopeIndex | null;
  isLoading: boolean;
  isSaving: boolean;
  onSave: (patch: {
    deliverables: string[];
    exclusions: string[];
    sla_terms: Record<string, string>;
    rate: number | null;
    rate_unit: string | null;
  }) => void;
  onConfirm: () => void;
}

function ListEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (next: string[]) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-hud-cream-soft mb-2">{label}</label>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={item}
              onChange={(e) => onChange(items.map((it, idx) => (idx === i ? e.target.value : it)))}
              className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
            />
            <button
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="px-2 text-hud-cream-dim hover:text-hud-plum"
              aria-label={`Remove ${label} item`}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => onChange([...items, ''])}
          className="text-sm text-hud-gold-soft hover:text-hud-gold-soft"
        >
          + Add
        </button>
      </div>
    </div>
  );
}

export function ScopeIndexTab({ scopeIndex, isLoading, isSaving, onSave, onConfirm }: ScopeIndexTabProps) {
  const [deliverables, setDeliverables] = useState<string[]>(scopeIndex?.deliverables ?? []);
  const [exclusions, setExclusions] = useState<string[]>(scopeIndex?.exclusions ?? []);
  const [rate, setRate] = useState<string>(scopeIndex?.rate != null ? String(scopeIndex.rate) : '');
  const [rateUnit, setRateUnit] = useState<string>(scopeIndex?.rate_unit ?? '');
  const [dirty, setDirty] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 text-hud-gold-soft animate-spin" />
      </div>
    );
  }

  if (!scopeIndex) {
    return (
      <div className="max-w-xl mx-auto text-center py-16 text-hud-cream-dim">
        <ListChecks className="w-8 h-8 mx-auto mb-3 text-hud-cream-mute" />
        <p>No scope index yet — it's extracted automatically once this contract is signed.</p>
      </div>
    );
  }

  const markDirty = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setDirty(true); };

  const save = () => {
    onSave({
      deliverables: deliverables.filter((d) => d.trim()),
      exclusions: exclusions.filter((e) => e.trim()),
      sla_terms: scopeIndex.sla_terms,
      rate: rate.trim() ? Number(rate) : null,
      rate_unit: rateUnit.trim() || null,
    });
    setDirty(false);
  };

  const isConfirmed = scopeIndex.status === 'confirmed';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isConfirmed ? (
            <span className="flex items-center gap-1.5 text-sm text-hud-emerald/40"><CheckCircle2 className="w-4 h-4" /> Confirmed</span>
          ) : (
            <span className="flex items-center gap-1.5 text-sm text-hud-rust/40"><Clock3 className="w-4 h-4" /> Needs review</span>
          )}
        </div>
        {!isConfirmed && (
          <button
            onClick={onConfirm}
            disabled={isSaving || dirty}
            title={dirty ? 'Save your edits first' : undefined}
            className="flex items-center gap-2 px-4 py-2 bg-hud-emerald-dim hover:bg-hud-emerald disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg text-sm transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" /> Confirm
          </button>
        )}
      </div>

      <ListEditor label="Deliverables" items={deliverables} onChange={markDirty(setDeliverables)} />
      <ListEditor label="Exclusions" items={exclusions} onChange={markDirty(setExclusions)} />

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="flex items-center gap-1.5 text-sm font-medium text-hud-cream-soft mb-2">
            <DollarSign className="w-4 h-4" /> Rate
          </label>
          <input
            value={rate}
            onChange={(e) => markDirty(setRate)(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-2">Unit</label>
          <input
            value={rateUnit}
            onChange={(e) => markDirty(setRateUnit)(e.target.value)}
            placeholder="e.g. monthly, per project"
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold/50"
          />
        </div>
      </div>

      {Object.keys(scopeIndex.sla_terms || {}).length > 0 && (
        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-2">SLA terms</label>
          <div className="space-y-1 text-sm text-hud-cream-soft">
            {Object.entries(scopeIndex.sla_terms).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-hud-cream-mute">{k}:</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!scopeIndex.deliverables.length && !scopeIndex.exclusions.length && (
        <div className="flex items-center gap-2 text-sm text-hud-cream-mute">
          <Ban className="w-4 h-4" /> Nothing was extracted for deliverables or exclusions — the contract text may not have stated them explicitly.
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={!dirty || isSaving}
          className="flex items-center gap-2 px-4 py-2 bg-hud-gold-deep hover:bg-hud-gold disabled:bg-hud-bg-elev disabled:text-hud-cream-dim disabled:cursor-not-allowed text-white hover:text-hud-bg-deep rounded-lg text-sm transition-colors"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Save changes
        </button>
      </div>
    </div>
  );
}
