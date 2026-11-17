import { useState, useEffect } from 'react';
import { FolderOpen, Plus, Pencil, Trash2, GripVertical, AlertCircle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import * as customValuesService from '../../../services/customValues';
import { getErrorMessage } from '../../../lib/errors';
import type { CustomValueCategory } from '../../../services/customValues';

interface Props {
  onSuccess?: () => void;
}

export function CustomValueCategoriesTab({ onSuccess }: Props) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState<CustomValueCategory[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.organization_id) {
      loadCategories();
    }
  }, [user?.organization_id]);

  const loadCategories = async () => {
    if (!user?.organization_id) return;

    try {
      setLoading(true);
      const data = await customValuesService.getCategories(user.organization_id);
      setCategories(data);
    } catch (err) {
      console.error('Failed to load categories:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddCategory = async () => {
    if (!user?.organization_id || !newCategoryName.trim()) return;

    try {
      setSaving(true);
      setError(null);
      await customValuesService.createCategory(user.organization_id, {
        name: newCategoryName.trim(),
      });
      setNewCategoryName('');
      setShowAddForm(false);
      loadCategories();
      onSuccess?.();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create category'));
    } finally {
      setSaving(false);
    }
  };

  const handleStartEdit = (category: CustomValueCategory) => {
    setEditingId(category.id);
    setEditName(category.name);
    setDeleteError(null);
  };

  const handleSaveEdit = async () => {
    if (!user?.organization_id || !editingId || !editName.trim()) return;

    try {
      setSaving(true);
      setError(null);
      await customValuesService.updateCategory(user.organization_id, editingId, {
        name: editName.trim(),
      });
      setEditingId(null);
      setEditName('');
      loadCategories();
      onSuccess?.();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update category'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setError(null);
  };

  const handleDelete = async (categoryId: string) => {
    if (!user?.organization_id) return;

    const category = categories.find(c => c.id === categoryId);
    if (category && (category.value_count || 0) > 0) {
      setDeleteError(`Cannot delete "${category.name}" because it contains ${category.value_count} value${(category.value_count || 0) > 1 ? 's' : ''}. Move or delete the values first.`);
      return;
    }

    try {
      await customValuesService.deleteCategory(user.organization_id, categoryId);
      loadCategories();
      onSuccess?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete category');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-hud-cream-dim">
          Organize your custom values into categories for easier management
        </p>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-hud-gold-soft hover:text-hud-gold-soft"
          >
            <Plus className="h-4 w-4" />
            Add Category
          </button>
        )}
      </div>

      {deleteError && (
        <div className="flex items-center gap-2 p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-lg">
          <AlertCircle className="h-4 w-4 text-hud-plum flex-shrink-0" />
          <p className="text-sm text-hud-plum">{deleteError}</p>
          <button
            onClick={() => setDeleteError(null)}
            className="ml-auto text-hud-plum hover:text-hud-plum/40 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}

      {showAddForm && (
        <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev p-4">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="Category name"
              className="flex-1 px-3 py-2 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddCategory();
                if (e.key === 'Escape') {
                  setShowAddForm(false);
                  setNewCategoryName('');
                }
              }}
            />
            <button
              onClick={handleAddCategory}
              disabled={!newCategoryName.trim() || saving}
              className="px-4 py-2 bg-gradient-to-r from-hud-gold to-hud-teal text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110"
            >
              {saving ? 'Adding...' : 'Add'}
            </button>
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewCategoryName('');
                setError(null);
              }}
              className="px-4 py-2 text-hud-cream-dim hover:text-hud-cream-soft text-sm"
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="mt-2 text-sm text-hud-plum">{error}</p>
          )}
        </div>
      )}

      <div className="bg-hud-bg-card rounded-xl border border-hud-bg-elev overflow-hidden">
        {categories.length === 0 ? (
          <div className="text-center py-12">
            <FolderOpen className="mx-auto h-12 w-12 text-hud-cream-mute" />
            <h3 className="mt-4 text-sm font-medium text-white">No categories yet</h3>
            <p className="mt-1 text-sm text-hud-cream-dim">
              Create categories to organize your custom values
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hud-bg-elev">
            {categories.map((category) => (
              <li
                key={category.id}
                className="flex items-center gap-4 px-4 py-3 hover:bg-hud-bg-elev/50 transition-colors"
              >
                <GripVertical className="h-4 w-4 text-hud-cream-mute cursor-grab" />
                <FolderOpen className="h-5 w-5 text-hud-cream-mute" />

                {editingId === category.id ? (
                  <div className="flex-1 flex items-center gap-3">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="flex-1 px-3 py-1.5 bg-hud-bg-mid border border-hud-bg-elev rounded-lg text-sm text-white focus:ring-2 focus:ring-hud-gold focus:border-hud-gold"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit();
                        if (e.key === 'Escape') handleCancelEdit();
                      }}
                    />
                    <button
                      onClick={handleSaveEdit}
                      disabled={!editName.trim() || saving}
                      className="px-3 py-1.5 bg-hud-gold text-hud-bg-deep rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-hud-gold-deep"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="px-3 py-1.5 text-hud-cream-dim hover:text-hud-cream-soft text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex-1">
                      <span className="text-white font-medium">{category.name}</span>
                      {category.description && (
                        <p className="text-sm text-hud-cream-dim mt-0.5">{category.description}</p>
                      )}
                    </div>
                    <span className="px-2 py-0.5 bg-hud-bg-elev text-hud-cream-soft rounded-full text-xs font-medium">
                      {category.value_count || 0} value{(category.value_count || 0) !== 1 ? 's' : ''}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleStartEdit(category)}
                        className="p-1.5 text-hud-cream-mute hover:text-hud-cream-soft rounded hover:bg-hud-bg-elev"
                        title="Rename"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(category.id)}
                        disabled={(category.value_count || 0) > 0}
                        className="p-1.5 text-hud-cream-mute hover:text-hud-plum rounded hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed"
                        title={(category.value_count || 0) > 0 ? 'Cannot delete category with values' : 'Delete'}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
