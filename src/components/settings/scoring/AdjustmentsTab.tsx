import { useState, useEffect } from 'react';
import { Calendar, User, ArrowUpRight, ArrowDownRight, History } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { getModels, type ScoringModel, type ScoreEvent, formatScoreChange } from '../../../services/scoring';
import { formatDateTimeShort } from '../../../utils/formatters';

export function AdjustmentsTab() {
  const [models, setModels] = useState<ScoringModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>('manual');

  useEffect(() => {
    loadModels();
  }, []);

  useEffect(() => {
    loadEvents();
  }, [selectedModelId, sourceFilter]);

  async function loadModels() {
    try {
      const data = await getModels();
      setModels(data);
    } catch (error) {
      console.error('Failed to load models:', error);
    }
  }

  async function loadEvents() {
    try {
      setLoading(true);
      let query = supabase
        .from('score_events')
        .select(`
          *,
          scoring_rules(name),
          users:created_by(id, name, email)
        `)
        .eq('source', sourceFilter)
        .order('created_at', { ascending: false })
        .limit(100);

      if (selectedModelId) {
        query = query.eq('model_id', selectedModelId);
      }

      const { data, error } = await query;
      if (error) throw error;
      setEvents(data || []);
    } catch (error) {
      console.error('Failed to load events:', error);
    } finally {
      setLoading(false);
    }
  }

  function getEntityLink(event: ScoreEvent): string {
    if (event.entity_type === 'contact') {
      return `/contacts/${event.entity_id}`;
    }
    return `/opportunities/${event.entity_id}`;
  }

  function getScoreColor(delta: number): string {
    if (delta > 0) return 'text-hud-emerald';
    if (delta < 0) return 'text-hud-plum';
    return 'text-hud-cream-dim';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-hud-cream-dim">Source:</label>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
          >
            <option value="manual">Manual Adjustments</option>
            <option value="rule">Rule-Based</option>
            <option value="decay">Decay</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-hud-cream-dim">Model:</label>
          <select
            value={selectedModelId}
            onChange={(e) => setSelectedModelId(e.target.value)}
            className="px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
          >
            <option value="">All Models</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 bg-hud-bg-card/50 rounded-lg border border-dashed border-hud-bg-elev">
          <History className="h-12 w-12 text-hud-cream-mute mx-auto mb-4" />
          <p className="text-hud-cream-dim">No {sourceFilter} score changes found.</p>
        </div>
      ) : (
        <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-hud-bg-elev">
            <thead className="bg-hud-bg-card/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Entity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Change
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Reason
                </th>
                {sourceFilter === 'manual' && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                    Adjusted By
                  </th>
                )}
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="bg-hud-bg-card divide-y divide-hud-bg-elev">
              {events.map((event) => (
                <tr key={event.id} className="hover:bg-hud-bg-elev/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a
                      href={getEntityLink(event)}
                      className="text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft capitalize"
                    >
                      {event.entity_type} {event.entity_id.slice(0, 8)}...
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {event.points_delta > 0 ? (
                        <ArrowUpRight className="h-4 w-4 text-hud-emerald" />
                      ) : (
                        <ArrowDownRight className="h-4 w-4 text-hud-plum" />
                      )}
                      <span className={`text-sm font-semibold ${getScoreColor(event.points_delta)}`}>
                        {formatScoreChange(event.points_delta)}
                      </span>
                      <span className="text-xs text-hud-cream-mute">
                        ({event.previous_score} → {event.new_score})
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-hud-cream-soft line-clamp-1">{event.reason}</span>
                  </td>
                  {sourceFilter === 'manual' && (
                    <td className="px-6 py-4 whitespace-nowrap">
                      {event.users ? (
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4 text-hud-cream-mute" />
                          <span className="text-sm text-hud-cream-soft">
                            {event.users.name || event.users.email}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-hud-cream-mute">-</span>
                      )}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-hud-cream-mute" />
                      <span className="text-sm text-hud-cream-dim">{formatDateTimeShort(event.created_at, { hour: 'numeric' })}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
