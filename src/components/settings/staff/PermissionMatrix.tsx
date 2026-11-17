import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Loader2, Save, RotateCcw, AlertCircle } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  calculateEffectivePermissions,
  setUserPermissionOverride,
  resetUserPermissionsToRole,
  type EffectivePermission,
} from '../../../services/permissions';

interface PermissionMatrixProps {
  userId: string;
  roleId: string;
  canEdit: boolean;
  onUpdate?: () => void;
}

export function PermissionMatrix({ userId, roleId, canEdit, onUpdate }: PermissionMatrixProps) {
  const { user } = useAuth();
  const [permissions, setPermissions] = useState<EffectivePermission[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    loadPermissions();
  }, [userId, roleId]);

  const loadPermissions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const effectivePerms = await calculateEffectivePermissions(userId, roleId);
      setPermissions(effectivePerms);
      setPendingChanges(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      setIsLoading(false);
    }
  };

  const permissionsByModule = permissions.reduce(
    (acc, perm) => {
      const module = perm.permission.module_name;
      if (!acc[module]) {
        acc[module] = [];
      }
      acc[module].push(perm);
      return acc;
    },
    {} as Record<string, EffectivePermission[]>
  );

  const moduleNames = Object.keys(permissionsByModule).sort();

  const toggleModule = (moduleName: string) => {
    const newExpanded = new Set(expandedModules);
    if (newExpanded.has(moduleName)) {
      newExpanded.delete(moduleName);
    } else {
      newExpanded.add(moduleName);
    }
    setExpandedModules(newExpanded);
  };

  const getEffectiveValue = (perm: EffectivePermission): boolean => {
    if (pendingChanges.has(perm.permission.id)) {
      return pendingChanges.get(perm.permission.id)!;
    }
    return perm.granted;
  };

  const togglePermission = (perm: EffectivePermission) => {
    if (!canEdit) return;

    const currentValue = getEffectiveValue(perm);
    const newChanges = new Map(pendingChanges);

    if (perm.source === 'role') {
      newChanges.set(perm.permission.id, !currentValue);
    } else {
      if (pendingChanges.has(perm.permission.id)) {
        newChanges.delete(perm.permission.id);
      } else {
        newChanges.set(perm.permission.id, !currentValue);
      }
    }

    setPendingChanges(newChanges);
  };

  const handleSave = async () => {
    if (!user || pendingChanges.size === 0) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      for (const [permissionId, granted] of pendingChanges) {
        await setUserPermissionOverride(userId, permissionId, granted, user);
      }
      setSuccess('Permissions updated successfully');
      await loadPermissions();
      onUpdate?.();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    if (!user) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);

    try {
      await resetUserPermissionsToRole(userId, user);
      setSuccess('Permissions reset to role defaults');
      await loadPermissions();
      onUpdate?.();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset permissions');
    } finally {
      setIsSaving(false);
    }
  };

  const hasOverrides = permissions.some((p) => p.source === 'override');
  const hasPendingChanges = pendingChanges.size > 0;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20">
          <AlertCircle className="w-5 h-5 text-hud-plum flex-shrink-0" />
          <p className="text-sm text-hud-plum">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-emerald/10 border border-hud-emerald/20">
          <AlertCircle className="w-5 h-5 text-hud-emerald flex-shrink-0" />
          <p className="text-sm text-hud-emerald">{success}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium text-white">Permission Overrides</h4>
          <p className="text-xs text-hud-cream-dim mt-0.5">
            {hasOverrides
              ? 'This user has custom permission overrides'
              : 'Using default role permissions'}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {hasOverrides && (
              <button
                onClick={handleReset}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-hud-bg-card text-hud-cream-soft hover:bg-hud-bg-elev border border-hud-bg-elev transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset to Role
              </button>
            )}
            {hasPendingChanges && (
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors disabled:opacity-50"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
                Save Changes
              </button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2 max-h-[500px] overflow-y-auto">
        {moduleNames.map((moduleName) => {
          const modulePermissions = permissionsByModule[moduleName];
          const isExpanded = expandedModules.has(moduleName);
          const hasModuleOverrides = modulePermissions.some(
            (p) => p.source === 'override' || pendingChanges.has(p.permission.id)
          );

          return (
            <div key={moduleName} className="border border-hud-bg-card rounded-lg overflow-hidden">
              <button
                onClick={() => toggleModule(moduleName)}
                className="w-full flex items-center justify-between px-4 py-3 bg-hud-bg-card/50 hover:bg-hud-bg-card transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white capitalize">
                    {moduleName.replace(/_/g, ' ')}
                  </span>
                  {hasModuleOverrides && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-hud-rust/10 text-hud-rust border border-hud-rust/20">
                      Modified
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-hud-cream-mute">
                    {modulePermissions.filter((p) => getEffectiveValue(p)).length}/
                    {modulePermissions.length}
                  </span>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-hud-cream-dim" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-hud-cream-dim" />
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="divide-y divide-hud-bg-card">
                  {modulePermissions.map((perm) => {
                    const isGranted = getEffectiveValue(perm);
                    const isOverridden = perm.source === 'override';
                    const hasPending = pendingChanges.has(perm.permission.id);
                    const isModified = isOverridden || hasPending;

                    return (
                      <div
                        key={perm.permission.id}
                        className={`flex items-center justify-between px-4 py-2.5 ${
                          isModified ? 'bg-hud-rust/5' : ''
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-4">
                          <p className="text-sm text-white">{perm.permission.key}</p>
                          {perm.permission.description && (
                            <p className="text-xs text-hud-cream-mute truncate">
                              {perm.permission.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isModified && (
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded border ${
                                hasPending
                                  ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                  : 'bg-hud-rust/10 text-hud-rust border-hud-rust/20'
                              }`}
                            >
                              {hasPending ? 'Pending' : 'Override'}
                            </span>
                          )}
                          <button
                            onClick={() => togglePermission(perm)}
                            disabled={!canEdit || isSaving}
                            className={`relative w-10 h-5 rounded-full transition-colors disabled:cursor-not-allowed ${
                              isGranted ? 'bg-hud-gold' : 'bg-hud-bg-elev'
                            } ${!canEdit ? 'opacity-60' : ''}`}
                          >
                            <span
                              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                                isGranted ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasPendingChanges && canEdit && (
        <div className="flex items-center justify-between p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p className="text-sm text-blue-400">
            You have {pendingChanges.size} unsaved change{pendingChanges.size !== 1 ? 's' : ''}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPendingChanges(new Map())}
              className="text-sm text-hud-cream-dim hover:text-white transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-hud-gold-deep text-white hover:text-hud-bg-deep hover:bg-hud-gold transition-colors disabled:opacity-50"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
