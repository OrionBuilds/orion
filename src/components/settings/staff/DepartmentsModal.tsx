import { useState, useEffect } from 'react';
import {
  X,
  Loader2,
  Building2,
  Plus,
  Edit2,
  Check,
  XCircle,
  Users,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getDepartmentWithUserCount,
  createDepartment,
  updateDepartment,
  disableDepartment,
  enableDepartment,
} from '../../../services/departments';
import type { Department } from '../../../types';
import { Portal } from '../../shared/Portal';

interface DepartmentWithCount extends Department {
  user_count: number;
}

interface DepartmentsModalProps {
  onClose: () => void;
  onUpdate: () => void;
}

export function DepartmentsModal({ onClose, onUpdate }: DepartmentsModalProps) {
  const { user, hasPermission, isSuperAdmin } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [departments, setDepartments] = useState<DepartmentWithCount[]>([]);
  const [showDisabled, setShowDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [newDeptName, setNewDeptName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const canManage = hasPermission('departments.manage') || isSuperAdmin;

  useEffect(() => {
    loadDepartments();
  }, [user?.organization_id, showDisabled]);

  const loadDepartments = async () => {
    if (!user?.organization_id) return;
    setIsLoading(true);
    try {
      const data = await getDepartmentWithUserCount(user.organization_id, showDisabled);
      setDepartments(data as DepartmentWithCount[]);
    } catch (err) {
      console.error('Failed to load departments:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!user?.organization_id || !newDeptName.trim()) return;
    setError(null);
    setIsCreating(true);

    try {
      await createDepartment(newDeptName.trim(), user.organization_id, user);
      setNewDeptName('');
      setShowCreateForm(false);
      setSuccess('Department created successfully');
      await loadDepartments();
      onUpdate();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create department');
    } finally {
      setIsCreating(false);
    }
  };

  const handleStartEdit = (dept: DepartmentWithCount) => {
    setEditingId(dept.id);
    setEditingName(dept.name);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const handleSaveEdit = async () => {
    if (!user || !editingId || !editingName.trim()) return;
    setError(null);
    setIsSaving(true);

    try {
      await updateDepartment(editingId, { name: editingName.trim() }, user);
      setEditingId(null);
      setEditingName('');
      setSuccess('Department updated successfully');
      await loadDepartments();
      onUpdate();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update department');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (dept: DepartmentWithCount) => {
    if (!user) return;
    setError(null);

    try {
      if (dept.status === 'active') {
        await disableDepartment(dept.id, user);
        setSuccess('Department disabled');
      } else {
        await enableDepartment(dept.id, user);
        setSuccess('Department enabled');
      }
      await loadDepartments();
      onUpdate();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update department status');
    }
  };

  return (
    <Portal><div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card max-w-lg w-full max-h-[80dvh] overflow-hidden flex flex-col">
        <div className="border-b border-hud-bg-card p-6 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-hud-gold/10 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-hud-gold-soft" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Departments</h2>
              <p className="text-sm text-hud-cream-dim">Manage organization departments</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-hud-bg-card transition-colors"
          >
            <X className="w-5 h-5 text-hud-cream-dim" />
          </button>
        </div>

        <div className="p-4 border-b border-hud-bg-card flex items-center justify-between flex-shrink-0">
          {canManage && (
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Add Department
            </button>
          )}
          <label className="flex items-center gap-2 text-sm text-hud-cream-dim cursor-pointer">
            <input
              type="checkbox"
              checked={showDisabled}
              onChange={(e) => setShowDisabled(e.target.checked)}
              className="rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold"
            />
            Show disabled
          </label>
        </div>

        {showCreateForm && canManage && (
          <div className="p-4 border-b border-hud-bg-card bg-hud-bg-card/30 flex-shrink-0">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                placeholder="Department name"
                className="flex-1 px-3 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') {
                    setShowCreateForm(false);
                    setNewDeptName('');
                  }
                }}
                autoFocus
              />
              <button
                onClick={handleCreate}
                disabled={isCreating || !newDeptName.trim()}
                className="p-2 rounded-lg bg-hud-emerald-dim text-white hover:text-hud-bg-deep hover:bg-hud-emerald disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewDeptName('');
                }}
                className="p-2 rounded-lg bg-hud-bg-elev text-white hover:bg-hud-cream-mute"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {(error || success) && (
          <div className="px-4 pt-4 flex-shrink-0">
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20">
                <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0" />
                <p className="text-sm text-hud-plum">{error}</p>
              </div>
            )}
            {success && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-emerald/10 border border-hud-emerald/20">
                <Check className="w-5 h-5 text-hud-emerald flex-shrink-0" />
                <p className="text-sm text-hud-emerald">{success}</p>
              </div>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
            </div>
          ) : departments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Building2 className="w-12 h-12 text-hud-cream-mute mb-3" />
              <p className="text-hud-cream-dim">No departments found</p>
              {canManage && (
                <p className="text-sm text-hud-cream-mute mt-1">
                  Create your first department to organize your team
                </p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-hud-bg-card">
              {departments.map((dept) => (
                <div
                  key={dept.id}
                  className={`p-4 hover:bg-hud-bg-card/30 transition-colors ${
                    dept.status === 'disabled' ? 'opacity-60' : ''
                  }`}
                >
                  {editingId === dept.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white focus:outline-none focus:ring-2 focus:ring-hud-gold text-sm"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveEdit();
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                        autoFocus
                      />
                      <button
                        onClick={handleSaveEdit}
                        disabled={isSaving || !editingName.trim()}
                        className="p-1.5 rounded-lg bg-hud-emerald-dim text-white hover:text-hud-bg-deep hover:bg-hud-emerald disabled:opacity-50"
                      >
                        {isSaving ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Check className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="p-1.5 rounded-lg bg-hud-bg-elev text-white hover:bg-hud-cream-mute"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-hud-bg-card flex items-center justify-center">
                          <Building2 className="w-4 h-4 text-hud-cream-dim" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{dept.name}</p>
                            {dept.status === 'disabled' && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-hud-bg-elev text-hud-cream-dim">
                                Disabled
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 text-xs text-hud-cream-mute">
                            <Users className="w-3 h-3" />
                            {dept.user_count} member{dept.user_count !== 1 ? 's' : ''}
                          </div>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleStartEdit(dept)}
                            className="p-1.5 rounded-lg hover:bg-hud-bg-elev transition-colors"
                            title="Edit name"
                          >
                            <Edit2 className="w-4 h-4 text-hud-cream-dim" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(dept)}
                            className="p-1.5 rounded-lg hover:bg-hud-bg-elev transition-colors"
                            title={dept.status === 'active' ? 'Disable' : 'Enable'}
                          >
                            {dept.status === 'active' ? (
                              <ToggleRight className="w-5 h-5 text-hud-emerald" />
                            ) : (
                              <ToggleLeft className="w-5 h-5 text-hud-cream-mute" />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-hud-bg-card p-4 flex justify-end flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev transition-colors font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div></Portal>
  );
}
