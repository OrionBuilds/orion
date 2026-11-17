import { useState, useEffect } from 'react';
import { BRANDS } from '../../lib/brands';
import { X, Filter, RotateCcw } from 'lucide-react';
import type { ContactFilters } from '../../services/contacts';
import type { Tag, Department, User, CustomField } from '../../types';
import { Portal } from '../shared/Portal';

interface ContactFilterDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  filters: ContactFilters;
  onFiltersChange: (filters: ContactFilters) => void;
  tags: Tag[];
  departments: Department[];
  users: User[];
  customFields: CustomField[];
  isAdmin: boolean;
}

export function ContactFilterDrawer({
  isOpen,
  onClose,
  filters,
  onFiltersChange,
  tags,
  departments,
  users,
  customFields,
  isAdmin,
}: ContactFilterDrawerProps) {
  const [localFilters, setLocalFilters] = useState<ContactFilters>(filters);

  useEffect(() => {
    setLocalFilters(filters);
  }, [filters]);

  const handleApply = () => {
    onFiltersChange(localFilters);
    onClose();
  };

  const handleClearAll = () => {
    setLocalFilters({});
  };

  const handleTagToggle = (tagId: string) => {
    const currentTags = localFilters.tagIds || [];
    const newTags = currentTags.includes(tagId)
      ? currentTags.filter((id) => id !== tagId)
      : [...currentTags, tagId];
    setLocalFilters({ ...localFilters, tagIds: newTags.length > 0 ? newTags : undefined });
  };

  const activeFilterCount = Object.entries(localFilters).filter(
    ([_, v]) => v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0)
  ).length;

  const filterableCustomFields = customFields.filter((f) => f.filterable && f.active);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop and panel share one Portal so the panel stays above its backdrop. */}
      <Portal>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-hud-bg-mid border-l border-hud-bg-card z-50 flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-hud-bg-card">
          <div className="flex items-center gap-3">
            <Filter className="w-5 h-5 text-hud-gold-soft" />
            <h2 className="text-lg font-semibold text-white">Filters</h2>
            {activeFilterCount > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-hud-gold/20 text-hud-gold-soft text-xs font-medium">
                {activeFilterCount}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors">
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Status</label>
            <select
              value={localFilters.status || ''}
              onChange={(e) =>
                setLocalFilters({
                  ...localFilters,
                  status: (e.target.value as 'active' | 'archived') || undefined,
                })
              }
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Brand</label>
            <select
              value={localFilters.brand || ''}
              onChange={(e) =>
                setLocalFilters({
                  ...localFilters,
                  brand: e.target.value || undefined,
                })
              }
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All brands</option>
              {BRANDS.map((b) => (
                <option key={b.slug} value={b.slug}>{b.name}</option>
              ))}
            </select>
          </div>

          {isAdmin && (
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">Department</label>
              <select
                value={localFilters.departmentId || ''}
                onChange={(e) =>
                  setLocalFilters({ ...localFilters, departmentId: e.target.value || undefined })
                }
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
              >
                <option value="">All departments</option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Owner</label>
            <select
              value={localFilters.ownerId || ''}
              onChange={(e) =>
                setLocalFilters({ ...localFilters, ownerId: e.target.value || undefined })
              }
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All owners</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Source</label>
            <input
              type="text"
              placeholder="e.g., website, referral"
              value={localFilters.source || ''}
              onChange={(e) =>
                setLocalFilters({ ...localFilters, source: e.target.value || undefined })
              }
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Lead Score Range</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                placeholder="Min"
                min={0}
                max={100}
                value={localFilters.leadScoreMin ?? ''}
                onChange={(e) =>
                  setLocalFilters({
                    ...localFilters,
                    leadScoreMin: e.target.value ? parseInt(e.target.value) : undefined,
                  })
                }
                className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
              <span className="text-hud-cream-mute">to</span>
              <input
                type="number"
                placeholder="Max"
                min={0}
                max={100}
                value={localFilters.leadScoreMax ?? ''}
                onChange={(e) =>
                  setLocalFilters({
                    ...localFilters,
                    leadScoreMax: e.target.value ? parseInt(e.target.value) : undefined,
                  })
                }
                className="flex-1 px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => setLocalFilters({ ...localFilters, leadScoreMin: 70, leadScoreMax: 100 })}
                className="px-2 py-1 text-xs rounded bg-hud-emerald/10 text-hud-emerald hover:bg-hud-emerald/20 transition-colors"
              >
                Hot (70+)
              </button>
              <button
                type="button"
                onClick={() => setLocalFilters({ ...localFilters, leadScoreMin: 40, leadScoreMax: 69 })}
                className="px-2 py-1 text-xs rounded bg-hud-rust/10 text-hud-rust hover:bg-hud-rust/20 transition-colors"
              >
                Warm (40-69)
              </button>
              <button
                type="button"
                onClick={() => setLocalFilters({ ...localFilters, leadScoreMin: 0, leadScoreMax: 39 })}
                className="px-2 py-1 text-xs rounded bg-hud-plum/10 text-hud-plum hover:bg-hud-plum/20 transition-colors"
              >
                Cold (0-39)
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Created Date Range</label>
            <div className="space-y-2">
              <input
                type="date"
                value={localFilters.createdAfter?.split('T')[0] || ''}
                onChange={(e) =>
                  setLocalFilters({
                    ...localFilters,
                    createdAfter: e.target.value ? `${e.target.value}T00:00:00Z` : undefined,
                  })
                }
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
              <input
                type="date"
                value={localFilters.createdBefore?.split('T')[0] || ''}
                onChange={(e) =>
                  setLocalFilters({
                    ...localFilters,
                    createdBefore: e.target.value ? `${e.target.value}T23:59:59Z` : undefined,
                  })
                }
                className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Tags</label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = localFilters.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => handleTagToggle(tag.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                      isSelected
                        ? 'ring-2 ring-offset-2 ring-offset-hud-bg-mid'
                        : 'opacity-60 hover:opacity-100'
                    }`}
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                      ...(isSelected ? { ringColor: tag.color } : {}),
                    }}
                  >
                    {tag.name}
                  </button>
                );
              })}
              {tags.length === 0 && <p className="text-sm text-hud-cream-mute">No tags available</p>}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Sort By</label>
            <select
              value={localFilters.sortBy || 'created_at'}
              onChange={(e) =>
                setLocalFilters({
                  ...localFilters,
                  sortBy: e.target.value as ContactFilters['sortBy'],
                })
              }
              className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
            >
              <option value="created_at">Date Created</option>
              <option value="last_activity_at">Last Activity</option>
              <option value="name">Name</option>
              <option value="lead_score">Lead Score</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">Sort Order</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setLocalFilters({ ...localFilters, sortOrder: 'desc' })}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  (localFilters.sortOrder || 'desc') === 'desc'
                    ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30'
                    : 'bg-hud-bg-card text-hud-cream-dim border border-hud-bg-elev hover:bg-hud-bg-elev'
                }`}
              >
                Descending
              </button>
              <button
                type="button"
                onClick={() => setLocalFilters({ ...localFilters, sortOrder: 'asc' })}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  localFilters.sortOrder === 'asc'
                    ? 'bg-hud-gold/20 text-hud-gold-soft border border-hud-gold/30'
                    : 'bg-hud-bg-card text-hud-cream-dim border border-hud-bg-elev hover:bg-hud-bg-elev'
                }`}
              >
                Ascending
              </button>
            </div>
          </div>

          {filterableCustomFields.length > 0 && (
            <div className="border-t border-hud-bg-card pt-6">
              <h3 className="text-sm font-medium text-hud-cream-soft mb-4">Custom Fields</h3>
              <p className="text-xs text-hud-cream-mute">Custom field filtering coming soon</p>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-hud-bg-card flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={handleClearAll}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-card transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Clear All
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-hud-cream-dim hover:text-white hover:bg-hud-bg-card transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="px-6 py-2 rounded-lg bg-hud-gold text-hud-bg-deep font-medium hover:bg-hud-gold-deep transition-colors"
            >
              Apply Filters
            </button>
          </div>
        </div>
      </div>
      </Portal>
    </>
  );
}
