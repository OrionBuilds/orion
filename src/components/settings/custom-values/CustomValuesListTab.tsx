import { useState, useEffect } from 'react';
import { Search, Filter, Pencil, Trash2, Copy, CheckCircle, MoreVertical, Braces, Clock } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import * as customValuesService from '../../../services/customValues';
import type { CustomValue, CustomValueCategory, CustomValueFilters } from '../../../services/customValues';
import { DeleteCustomValueModal } from './DeleteCustomValueModal';
import { Tooltip } from '../../Tooltip';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

interface Props {
  onEdit: (valueId: string) => void;
  onSuccess?: () => void;
}

export function CustomValuesListTab({ onEdit, onSuccess }: Props) {
  const { user, hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<CustomValue[]>([]);
  const [categories, setCategories] = useState<CustomValueCategory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<CustomValueFilters>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomValue | null>(null);
  const [actionMenu, setActionMenu] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});

  const canEdit = hasPermission('custom_values.edit');
  const canDelete = hasPermission('custom_values.delete');

  useEffect(() => {
    if (user?.organization_id) {
      loadData();
    }
  }, [user?.organization_id, page, filters]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(prev => ({ ...prev, search: searchQuery || undefined }));
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadData = async () => {
    if (!user?.organization_id) return;

    try {
      setLoading(true);
      const [valuesResult, categoriesResult] = await Promise.all([
        customValuesService.getCustomValues(user.organization_id, filters, { page, limit: 20 }),
        customValuesService.getCategories(user.organization_id),
      ]);

      setValues(valuesResult.data);
      setTotalCount(valuesResult.pagination.total);
      setCategories(categoriesResult);

      const counts: Record<string, number> = {};
      for (const val of valuesResult.data) {
        const usage = await customValuesService.getCustomValueUsageCount(user.organization_id, val.id);
        counts[val.id] = usage.total;
      }
      setUsageCounts(counts);
    } catch (err) {
      console.error('Failed to load custom values:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyToken = async (value: CustomValue) => {
    try {
      const token = customValuesService.formatTokenKey(value.key);
      await navigator.clipboard.writeText(token);
      setCopiedId(value.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDuplicate = async (valueId: string) => {
    if (!user?.organization_id) return;

    try {
      await customValuesService.duplicateCustomValue(user.organization_id, user.id, valueId);
      setActionMenu(null);
      loadData();
      onSuccess?.();
    } catch (err) {
      console.error('Failed to duplicate:', err);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!user?.organization_id || !deleteTarget) return;

    try {
      await customValuesService.deleteCustomValue(user.organization_id, deleteTarget.id);
      setDeleteTarget(null);
      loadData();
      onSuccess?.();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const formatRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const totalPages = Math.ceil(totalCount / 20);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-hud-cream-mute" />
            <input
              type="text"
              placeholder="Search by name or key..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm font-medium transition-colors ${
              showFilters
                ? 'border-hud-gold bg-hud-gold/10 text-hud-gold-soft'
                : 'border-hud-bg-elev text-hud-cream-dim hover:bg-hud-bg-card hover:text-hud-cream-soft'
            }`}
          >
            <Filter className="h-4 w-4" />
            Filters
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="flex items-center gap-4 p-4 bg-hud-bg-card rounded-lg border border-hud-bg-elev">
          <div>
            <label className="block text-xs font-medium text-hud-cream-mute mb-1">Category</label>
            <select
              value={filters.category_id || ''}
              onChange={(e) => {
                setFilters(prev => ({ ...prev, category_id: e.target.value || undefined }));
                setPage(1);
              }}
              className="px-3 py-1.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:ring-2 focus:ring-hud-gold"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => {
              setFilters({});
              setSearchQuery('');
              setPage(1);
            }}
            className="mt-4 text-sm text-hud-cream-mute hover:text-hud-cream-soft"
          >
            Clear filters
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
        </div>
      ) : values.length === 0 ? (
        <div className="text-center py-12 bg-hud-bg-card rounded-xl border border-hud-bg-elev">
          <Braces className="mx-auto h-12 w-12 text-hud-cream-mute" />
          <h3 className="mt-4 text-sm font-medium text-white">No custom values found</h3>
          <p className="mt-1 text-sm text-hud-cream-dim">
            {searchQuery || filters.category_id
              ? 'Try adjusting your search or filters'
              : 'Get started by adding your first custom value'}
          </p>
        </div>
      ) : (
        <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev overflow-hidden">
          <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-hud-bg-elev">
            <thead className="bg-hud-bg-card/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Token
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Value
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Category
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Updated
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-hud-cream-dim uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hud-bg-elev">
              {values.map((value) => (
                <tr key={value.id} className="hover:bg-hud-bg-elev/50 transition-colors">
                  <td className="px-6 py-4">
                    <button
                      onClick={() => canEdit && onEdit(value.id)}
                      className={`font-medium text-white ${canEdit ? 'hover:text-hud-gold-soft cursor-pointer' : ''}`}
                    >
                      {value.name}
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <Tooltip content={usageCounts[value.id] ? `Used in ${usageCounts[value.id]} place${usageCounts[value.id] > 1 ? 's' : ''}` : 'Not used anywhere'}>
                      <div className="flex items-center gap-2">
                        <code className="px-2 py-1 bg-hud-bg-mid rounded text-xs font-mono text-hud-gold-soft border border-hud-bg-elev">
                          {customValuesService.formatTokenKey(value.key)}
                        </code>
                        <button
                          onClick={() => handleCopyToken(value)}
                          className="p-1 text-hud-cream-mute hover:text-hud-cream-soft rounded"
                          title="Copy token"
                        >
                          {copiedId === value.id ? (
                            <CheckCircle className="h-4 w-4 text-hud-emerald" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </Tooltip>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-hud-cream-soft max-w-[200px] truncate block">
                      {value.value.length > 50 ? value.value.substring(0, 50) + '...' : value.value}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {value.custom_value_categories ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-hud-bg-elev text-hud-cream-soft">
                        {value.custom_value_categories.name}
                      </span>
                    ) : (
                      <span className="text-hud-cream-mute text-sm">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-1.5 text-sm text-hud-cream-dim">
                      <Clock className="h-3.5 w-3.5" />
                      {formatRelativeTime(value.updated_at)}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="relative inline-block">
                      <button
                        onClick={() => setActionMenu(actionMenu === value.id ? null : value.id)}
                        className="p-1 text-hud-cream-mute hover:text-hud-cream-soft rounded-lg hover:bg-hud-bg-elev"
                      >
                        <MoreVertical className="h-5 w-5" />
                      </button>
                      {actionMenu === value.id && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => setActionMenu(null)}
                          />
                          <AnchoredMenu className="z-50 w-48 bg-hud-bg-card rounded-lg shadow-lg border border-hud-bg-elev py-1">
                            {canEdit && (
                              <button
                                onClick={() => {
                                  onEdit(value.id);
                                  setActionMenu(null);
                                }}
                                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                              >
                                <Pencil className="h-4 w-4" />
                                Edit
                              </button>
                            )}
                            {canEdit && (
                              <button
                                onClick={() => handleDuplicate(value.id)}
                                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev"
                              >
                                <Copy className="h-4 w-4" />
                                Duplicate
                              </button>
                            )}
                            {canDelete && (
                              <button
                                onClick={() => {
                                  setDeleteTarget(value);
                                  setActionMenu(null);
                                }}
                                className="flex items-center gap-2 w-full px-4 py-2 text-sm text-hud-plum hover:bg-hud-plum/10"
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete
                              </button>
                            )}
                          </AnchoredMenu>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          {totalPages > 1 && (
            <div className="px-6 py-3 border-t border-hud-bg-elev flex items-center justify-between">
              <div className="text-sm text-hud-cream-dim">
                Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, totalCount)} of {totalCount}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft disabled:opacity-50 disabled:cursor-not-allowed hover:bg-hud-bg-elev"
                >
                  Previous
                </button>
                <span className="text-sm text-hud-cream-dim">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 border border-hud-bg-elev rounded-lg text-sm text-hud-cream-soft disabled:opacity-50 disabled:cursor-not-allowed hover:bg-hud-bg-elev"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <DeleteCustomValueModal
          value={deleteTarget}
          usageCount={usageCounts[deleteTarget.id] || 0}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  );
}
