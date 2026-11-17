import { useState, useEffect } from 'react';
import { Plus, MoreVertical, Check, X, Trash2, Pencil, Zap } from 'lucide-react';
import { getModels, getRules, deleteRule, toggleRule, type ScoringModel, type ScoringRule, getTriggerTypeLabel, formatScoreChange } from '../../../services/scoring';
import { RuleFormModal } from './RuleFormModal';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

export function RulesTab() {
  const [models, setModels] = useState<ScoringModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [rules, setRules] = useState<ScoringRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ScoringRule | null>(null);
  const [actionMenuId, setActionMenuId] = useState<string | null>(null);

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    if (selectedModelId) {
      loadRules(selectedModelId);
    } else {
      setRules([]);
    }
  }, [selectedModelId]);

  async function loadModels() {
    try {
      const data = await getModels();
      setModels(data);
      if (data.length > 0) {
        const primary = data.find(m => m.is_primary) || data[0];
        setSelectedModelId(primary.id);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadRules(modelId: string) {
    try {
      setLoading(true);
      const data = await getRules(modelId);
      setRules(data);
    } catch (error) {
      console.error('Failed to load rules:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(rule: ScoringRule) {
    await toggleRule(rule.id, !rule.active);
    await loadRules(selectedModelId);
    setActionMenuId(null);
  }

  async function handleDelete(rule: ScoringRule) {
    if (!confirm(`Are you sure you want to delete "${rule.name}"?`)) {
      return;
    }
    await deleteRule(rule.id);
    await loadRules(selectedModelId);
    setActionMenuId(null);
  }

  function getFrequencyLabel(rule: ScoringRule): string {
    if (rule.frequency_type === 'once') return 'Once per entity';
    if (rule.frequency_type === 'unlimited') return 'Unlimited';
    if (rule.frequency_type === 'interval' && rule.cooldown_interval && rule.cooldown_unit) {
      return `Once per ${rule.cooldown_interval} ${rule.cooldown_unit}`;
    }
    return rule.frequency_type;
  }

  function getScoreColor(delta: number): string {
    if (delta > 0) return 'text-hud-emerald';
    if (delta < 0) return 'text-hud-plum';
    return 'text-hud-cream-dim';
  }

  if (loading && models.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-hud-cream-dim">Model:</label>
          <select
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
          >
            <option value="">Select a model</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({model.scope})
              </option>
            ))}
          </select>
        </div>
        {selectedModelId && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg shadow-lg shadow-hud-gold/25 hover:shadow-hud-gold/40 hover:brightness-110 transition-all"
          >
            <Plus className="h-4 w-4" />
            Add Rule
          </button>
        )}
      </div>

      {!selectedModelId ? (
        <div className="text-center py-12 bg-hud-bg-card/50 rounded-lg border border-dashed border-hud-bg-elev">
          <p className="text-hud-cream-dim">Select a scoring model to view and manage its rules.</p>
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 bg-hud-bg-card/50 rounded-lg border border-dashed border-hud-bg-elev">
          <Zap className="h-12 w-12 text-hud-cream-mute mx-auto mb-4" />
          <h3 className="text-lg font-medium text-white mb-2">No rules yet</h3>
          <p className="text-hud-cream-dim mb-4">Create rules to define how scores change based on actions.</p>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg shadow-lg shadow-hud-gold/25 hover:shadow-hud-gold/40 hover:brightness-110 transition-all"
          >
            <Plus className="h-4 w-4" />
            Add Rule
          </button>
        </div>
      ) : (
        <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-hud-bg-elev">
            <thead className="bg-hud-bg-card/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Rule Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Trigger
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Points
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Frequency
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-hud-bg-card divide-y divide-hud-bg-elev">
              {rules.map((rule) => (
                <tr key={rule.id} className="hover:bg-hud-bg-elev/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="text-sm font-medium text-white">{rule.name}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="text-sm text-hud-cream-soft">{getTriggerTypeLabel(rule.trigger_type)}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`text-sm font-semibold ${getScoreColor(rule.points)}`}>
                      {formatScoreChange(rule.points)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="text-sm text-hud-cream-dim">{getFrequencyLabel(rule)}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {rule.active ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-hud-emerald/20 text-hud-emerald border border-hud-emerald/30">
                        <Check className="h-3 w-3" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-hud-bg-elev text-hud-cream-dim">
                        <X className="h-3 w-3" />
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="relative">
                      <button
                        onClick={() => setActionMenuId(actionMenuId === rule.id ? null : rule.id)}
                        className="p-1 rounded hover:bg-hud-bg-elev"
                      >
                        <MoreVertical className="h-5 w-5 text-hud-cream-dim" />
                      </button>
                      {actionMenuId === rule.id && (
                        <AnchoredMenu className="w-40 rounded-lg shadow-xl bg-hud-bg-card border border-hud-bg-elev z-50">
                          <div className="py-1">
                            <button
                              onClick={() => {
                                setEditingRule(rule);
                                setActionMenuId(null);
                              }}
                              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                            >
                              <Pencil className="h-4 w-4" />
                              Edit
                            </button>
                            <button
                              onClick={() => handleToggle(rule)}
                              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                            >
                              {rule.active ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                              {rule.active ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              onClick={() => handleDelete(rule)}
                              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-plum hover:bg-hud-plum/10"
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </button>
                          </div>
                        </AnchoredMenu>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {(showModal || editingRule) && (
        <RuleFormModal
          modelId={selectedModelId}
          rule={editingRule}
          onClose={() => {
            setShowModal(false);
            setEditingRule(null);
          }}
          onSaved={() => {
            loadRules(selectedModelId);
            setShowModal(false);
            setEditingRule(null);
          }}
        />
      )}
    </div>
  );
}
