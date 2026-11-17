import { useEffect, useState } from 'react';
import { X, Search, Calendar } from 'lucide-react';
import type { OpportunityFilters, User, Department, PipelineStage, Tag } from '../../types';
import { getTags } from '../../services/tags';
import { useAuth } from '../../contexts/AuthContext';
import { Portal } from '../shared/Portal';

interface OpportunityFilterPanelProps {
  isOpen: boolean;
  filters: OpportunityFilters;
  users: User[];
  departments: Department[];
  stages: PipelineStage[];
  onFilterChange: (filters: OpportunityFilters) => void;
  onClose: () => void;
}

export function OpportunityFilterPanel({
  isOpen,
  filters,
  users,
  departments,
  stages,
  onFilterChange,
  onClose
}: OpportunityFilterPanelProps) {
  const { user } = useAuth();
  const [localFilters, setLocalFilters] = useState<OpportunityFilters>(filters);
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    setLocalFilters(filters);
  }, [filters]);

  useEffect(() => {
    if (user?.organization_id) {
      getTags(user.organization_id).then(setTags).catch(console.error);
    }
  }, [user?.organization_id]);

  const handleStatusToggle = (status: 'open' | 'won' | 'lost') => {
    const current = localFilters.status || [];
    const updated = current.includes(status)
      ? current.filter(s => s !== status)
      : [...current, status];
    setLocalFilters({ ...localFilters, status: updated.length > 0 ? updated : undefined });
  };

  const handleStageToggle = (stageId: string) => {
    const current = localFilters.stageId ? [localFilters.stageId] : [];
    if (current.includes(stageId)) {
      setLocalFilters({ ...localFilters, stageId: undefined });
    } else {
      setLocalFilters({ ...localFilters, stageId });
    }
  };

  const handleTagToggle = (tagId: string) => {
    const current = localFilters.tagIds || [];
    const updated = current.includes(tagId)
      ? current.filter(id => id !== tagId)
      : [...current, tagId];
    setLocalFilters({ ...localFilters, tagIds: updated.length > 0 ? updated : undefined });
  };

  const handleApply = () => {
    onFilterChange(localFilters);
    onClose();
  };

  const handleClear = () => {
    setLocalFilters({});
    onFilterChange({});
  };

  const activeCount = [
    localFilters.status?.length,
    localFilters.assignedUserId !== undefined ? 1 : 0,
    localFilters.departmentId ? 1 : 0,
    localFilters.stageId ? 1 : 0,
    localFilters.minValue !== undefined ? 1 : 0,
    localFilters.maxValue !== undefined ? 1 : 0,
    localFilters.createdAfter ? 1 : 0,
    localFilters.createdBefore ? 1 : 0,
    localFilters.tagIds?.length,
    localFilters.search ? 1 : 0
  ].reduce((a: number, b) => a + (b || 0), 0);

  if (!isOpen) return null;

  return (
    // Backdrop and panel share one Portal so the panel stays above its backdrop.
    <Portal>
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 left-0 w-80 bg-hud-bg-card border-r border-hud-bg-elev z-50 flex flex-col shadow-xl animate-slide-in-left">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-elev">
          <h2 className="text-lg font-semibold text-white">Filters</h2>
          <button onClick={onClose} className="p-1 hover:bg-hud-bg-elev rounded">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
              <input
                type="text"
                value={localFilters.search || ''}
                onChange={(e) => setLocalFilters({ ...localFilters, search: e.target.value || undefined })}
                placeholder="Contact name, email, phone..."
                className="w-full pl-10 pr-4 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white placeholder-hud-cream-dim text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Status</label>
            <div className="flex flex-wrap gap-2">
              {(['open', 'won', 'lost'] as const).map(status => (
                <button
                  key={status}
                  onClick={() => handleStatusToggle(status)}
                  className={`px-3 py-1.5 rounded text-sm capitalize ${
                    localFilters.status?.includes(status)
                      ? status === 'open' ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/50'
                        : status === 'won' ? 'bg-hud-emerald/20 text-hud-emerald border border-hud-emerald/50'
                        : 'bg-hud-plum/20 text-hud-plum border border-hud-plum/50'
                      : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Owner</label>
            <select
              value={localFilters.assignedUserId === null ? 'unassigned' : localFilters.assignedUserId || ''}
              onChange={(e) => {
                const val = e.target.value;
                setLocalFilters({
                  ...localFilters,
                  assignedUserId: val === '' ? undefined : val === 'unassigned' ? null : val
                });
              }}
              className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
            >
              <option value="">All users</option>
              <option value="unassigned">Unassigned</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Department</label>
            <select
              value={localFilters.departmentId || ''}
              onChange={(e) => setLocalFilters({ ...localFilters, departmentId: e.target.value || undefined })}
              className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
            >
              <option value="">All departments</option>
              {departments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          {stages.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">Stage</label>
              <div className="flex flex-wrap gap-2">
                {stages.map(stage => (
                  <button
                    key={stage.id}
                    onClick={() => handleStageToggle(stage.id)}
                    className={`px-3 py-1.5 rounded text-sm ${
                      localFilters.stageId === stage.id
                        ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/50'
                        : 'bg-hud-bg-elev text-hud-cream-soft hover:bg-hud-cream-mute'
                    }`}
                  >
                    {stage.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Value Range</label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-dim">$</span>
                <input
                  type="number"
                  value={localFilters.minValue ?? ''}
                  onChange={(e) => setLocalFilters({
                    ...localFilters,
                    minValue: e.target.value ? parseFloat(e.target.value) : undefined
                  })}
                  placeholder="Min"
                  className="w-full pl-7 pr-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
                />
              </div>
              <span className="text-hud-cream-dim">-</span>
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-hud-cream-dim">$</span>
                <input
                  type="number"
                  value={localFilters.maxValue ?? ''}
                  onChange={(e) => setLocalFilters({
                    ...localFilters,
                    maxValue: e.target.value ? parseFloat(e.target.value) : undefined
                  })}
                  placeholder="Max"
                  className="w-full pl-7 pr-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Created Date</label>
            <div className="space-y-2">
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
                <input
                  type="date"
                  value={localFilters.createdAfter || ''}
                  onChange={(e) => setLocalFilters({
                    ...localFilters,
                    createdAfter: e.target.value || undefined
                  })}
                  className="w-full pl-10 pr-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
                />
              </div>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-dim" />
                <input
                  type="date"
                  value={localFilters.createdBefore || ''}
                  onChange={(e) => setLocalFilters({
                    ...localFilters,
                    createdBefore: e.target.value || undefined
                  })}
                  className="w-full pl-10 pr-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded-lg text-white text-sm"
                />
              </div>
            </div>
          </div>

          {tags.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">Tags</label>
              <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                {tags.map(tag => (
                  <button
                    key={tag.id}
                    onClick={() => handleTagToggle(tag.id)}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${
                      localFilters.tagIds?.includes(tag.id)
                        ? 'ring-2 ring-white'
                        : ''
                    }`}
                    style={{
                      backgroundColor: `${tag.color}30`,
                      color: tag.color
                    }}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-hud-bg-elev space-y-2">
          <button
            onClick={handleApply}
            className="w-full px-4 py-2 bg-hud-gold-deep text-white rounded-lg hover:bg-hud-gold-deep font-medium"
          >
            Apply Filters
            {activeCount > 0 && ` (${activeCount})`}
          </button>
          {activeCount > 0 && (
            <button
              onClick={handleClear}
              className="w-full px-4 py-2 text-hud-cream-dim hover:text-white rounded-lg"
            >
              Clear All
            </button>
          )}
        </div>
      </div>
    </Portal>
  );
}
