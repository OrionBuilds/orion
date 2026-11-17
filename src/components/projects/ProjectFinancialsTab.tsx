import { useState, useEffect } from 'react';
import { Plus, DollarSign, Trash2, X, Loader2 } from 'lucide-react';
import type { ProjectCost } from '../../types';
import { getProjectCosts, createProjectCost, deleteProjectCost } from '../../services/projectCosts';

interface Props {
  projectId: string;
  orgId: string;
  budgetAmount: number;
  actualCost: number;
  currency: string;
  canEdit: boolean;
  currentUserId: string;
  onCostChange: () => void;
}

const CATEGORIES = ['labor', 'materials', 'software', 'travel', 'other'];

const CATEGORY_COLORS: Record<string, string> = {
  labor: 'bg-blue-500/20 text-blue-400',
  materials: 'bg-hud-rust/20 text-hud-rust',
  software: 'bg-hud-gold/20 text-hud-gold-soft',
  travel: 'bg-hud-emerald/20 text-hud-emerald',
  other: 'bg-hud-cream-mute/20 text-hud-cream-dim',
};

export function ProjectFinancialsTab({
  projectId,
  orgId,
  budgetAmount,
  actualCost,
  currency,
  canEdit,
  currentUserId,
  onCostChange,
}: Props) {
  const [costs, setCosts] = useState<ProjectCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    description: '',
    amount: '',
    category: 'other',
    date: new Date().toISOString().split('T')[0],
  });

  useEffect(() => {
    loadCosts();
  }, [projectId]);

  async function loadCosts() {
    try {
      const data = await getProjectCosts(projectId);
      setCosts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddCost(e: React.FormEvent) {
    e.preventDefault();
    if (!form.description.trim() || !form.amount) return;
    setSaving(true);
    try {
      await createProjectCost({
        org_id: orgId,
        project_id: projectId,
        description: form.description.trim(),
        amount: Number(form.amount),
        currency,
        category: form.category,
        date: form.date,
        created_by: currentUserId,
      }, currentUserId);
      setForm({ description: '', amount: '', category: 'other', date: new Date().toISOString().split('T')[0] });
      setShowAddForm(false);
      await loadCosts();
      onCostChange();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCost(id: string) {
    if (!confirm('Remove this cost?')) return;
    try {
      await deleteProjectCost(id, currentUserId);
      setCosts((prev) => prev.filter((c) => c.id !== id));
      onCostChange();
    } catch (err) {
      console.error(err);
    }
  }

  const remaining = budgetAmount - actualCost;
  const usedPercent = budgetAmount > 0 ? Math.round((actualCost / budgetAmount) * 100) : 0;
  const overBudget = actualCost > budgetAmount && budgetAmount > 0;

  if (loading) {
    return <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-hud-gold" /></div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-xl p-4">
          <p className="text-xs text-hud-cream-mute mb-1">Budget</p>
          <p className="text-xl font-bold text-white">${Number(budgetAmount).toLocaleString()}</p>
        </div>
        <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-xl p-4">
          <p className="text-xs text-hud-cream-mute mb-1">Spent</p>
          <p className={`text-xl font-bold ${overBudget ? 'text-hud-plum' : 'text-white'}`}>
            ${Number(actualCost).toLocaleString()}
          </p>
        </div>
        <div className="bg-hud-bg-card/50 border border-hud-bg-elev/50 rounded-xl p-4">
          <p className="text-xs text-hud-cream-mute mb-1">Remaining</p>
          <p className={`text-xl font-bold ${remaining < 0 ? 'text-hud-plum' : 'text-hud-emerald'}`}>
            ${Math.abs(remaining).toLocaleString()}{remaining < 0 ? ' over' : ''}
          </p>
        </div>
      </div>

      {budgetAmount > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-hud-cream-dim">Budget Usage</span>
            <span className={`text-sm font-medium ${overBudget ? 'text-hud-plum' : 'text-hud-cream-soft'}`}>
              {usedPercent}%
            </span>
          </div>
          <div className="w-full bg-hud-bg-elev rounded-full h-2.5">
            <div
              className={`h-full rounded-full transition-all ${overBudget ? 'bg-hud-plum' : usedPercent > 80 ? 'bg-hud-rust' : 'bg-hud-emerald'}`}
              style={{ width: `${Math.min(100, usedPercent)}%` }}
            />
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-white">Cost Items</h3>
          {canEdit && (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep text-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Cost
            </button>
          )}
        </div>

        {showAddForm && (
          <form onSubmit={handleAddCost} className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 space-y-3 mb-4">
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Description"
                className="bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm"
                autoFocus
              />
              <input
                type="number"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="Amount"
                className="bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm"
                min={0}
                step="0.01"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="bg-hud-bg-mid border border-hud-cream-mute rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowAddForm(false)} className="px-3 py-1.5 text-sm bg-hud-bg-elev text-hud-cream-soft rounded-lg">Cancel</button>
              <button type="submit" disabled={saving || !form.description.trim() || !form.amount} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-hud-gold-deep text-white rounded-lg disabled:opacity-50">
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Add
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2">
          {costs.map((cost) => (
            <div key={cost.id} className="flex items-center gap-3 px-3 py-2.5 bg-hud-bg-card/50 rounded-lg border border-hud-bg-elev/50 group">
              <DollarSign className="w-4 h-4 text-hud-cream-mute" />
              <span className="flex-1 text-sm text-white">{cost.description}</span>
              {cost.category && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${CATEGORY_COLORS[cost.category] || CATEGORY_COLORS.other}`}>
                  {cost.category}
                </span>
              )}
              <span className="text-sm text-hud-cream-soft font-medium tabular-nums">${Number(cost.amount).toLocaleString()}</span>
              <span className="text-xs text-hud-cream-mute">{new Date(cost.date).toLocaleDateString()}</span>
              {canEdit && (
                <button
                  onClick={() => handleDeleteCost(cost.id)}
                  className="p-1 text-hud-cream-mute hover:text-hud-plum opacity-0 group-hover:opacity-100 reveal-on-touch transition-opacity"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
          {costs.length === 0 && (
            <div className="text-center py-8 text-hud-cream-mute text-sm">No costs recorded yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
