import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { getOrganization, updateOrganization } from '../../services/organizations';
import { getDepartments, createDepartment, updateDepartment, deleteDepartment } from '../../services/departments';
import type { Organization, Department } from '../../types';
import { CompanyProfileSettings } from '../../components/settings/CompanyProfileSettings';
import { AgentClientCommsSettings } from '../../components/settings/AgentClientCommsSettings';
import { BuiltinAiSettings } from '../../components/settings/BuiltinAiSettings';
import {
  Building2,
  Save,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Mail,
  Phone,
  Globe,
} from 'lucide-react';

export function OrganizationSettingsPage() {
  const { user, hasPermission } = useAuth();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [orgName, setOrgName] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [orgPhone, setOrgPhone] = useState('');
  const [orgWebsite, setOrgWebsite] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDeptName, setNewDeptName] = useState('');
  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [editDeptName, setEditDeptName] = useState('');

  const canManage = hasPermission('settings.manage');

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    if (!user?.organization_id) return;

    try {
      setIsLoading(true);
      const [org, depts] = await Promise.all([
        getOrganization(user.organization_id),
        getDepartments(user.organization_id),
      ]);
      setOrganization(org);
      setOrgName(org?.name || '');
      setOrgEmail(org?.email || '');
      setOrgPhone(org?.phone || '');
      setOrgWebsite(org?.website || '');
      setDepartments(depts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveOrg = async () => {
    if (!organization || !user || !canManage) return;

    setIsSaving(true);
    setSaveSuccess(false);
    setError(null);

    try {
      await updateOrganization(organization.id, {
        name: orgName,
        email: orgEmail || null,
        phone: orgPhone || null,
        website: orgWebsite || null,
      }, user);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddDept = async () => {
    if (!user || !newDeptName.trim() || !canManage) return;

    try {
      await createDepartment(newDeptName.trim(), user.organization_id, user);
      setNewDeptName('');
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add department');
    }
  };

  const handleUpdateDept = async () => {
    if (!editingDept || !user || !editDeptName.trim() || !canManage) return;

    try {
      await updateDepartment(editingDept.id, { name: editDeptName.trim() }, user);
      setEditingDept(null);
      setEditDeptName('');
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update department');
    }
  };

  const handleDeleteDept = async (dept: Department) => {
    if (!user || !canManage) return;
    if (!confirm(`Are you sure you want to delete "${dept.name}"?`)) return;

    try {
      await deleteDepartment(dept.id, user);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete department');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="w-8 h-8 animate-spin text-hud-gold" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-hud-plum/10 border border-hud-plum/20 text-hud-plum text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        <div className="p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <Building2 className="w-5 h-5 text-hud-gold-soft" />
            Organization
          </h3>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Organization Name
            </label>
            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
              <input
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                disabled={!canManage}
                className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-hud-cream-soft mb-2">
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
              <input
                type="email"
                value={orgEmail}
                onChange={(e) => setOrgEmail(e.target.value)}
                disabled={!canManage}
                placeholder="info@example.com"
                className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Phone
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                <input
                  type="tel"
                  value={orgPhone}
                  onChange={(e) => setOrgPhone(e.target.value)}
                  disabled={!canManage}
                  placeholder="(555) 000-0000"
                  className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-hud-cream-soft mb-2">
                Website
              </label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
                <input
                  type="url"
                  value={orgWebsite}
                  onChange={(e) => setOrgWebsite(e.target.value)}
                  disabled={!canManage}
                  placeholder="https://example.com"
                  className="w-full pl-10 pr-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent disabled:opacity-50"
                />
              </div>
            </div>
          </div>
          {canManage && (
            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveOrg}
                disabled={isSaving || (
                  orgName === (organization?.name || '') &&
                  orgEmail === (organization?.email || '') &&
                  orgPhone === (organization?.phone || '') &&
                  orgWebsite === (organization?.website || '')
                )}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-r from-hud-gold to-hud-teal text-white font-medium hover:from-hud-gold-deep hover:to-hud-teal disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : saveSuccess ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {saveSuccess ? 'Saved' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </div>

      <CompanyProfileSettings canManage={canManage} />

      <AgentClientCommsSettings canManage={canManage} />

      <BuiltinAiSettings canManage={canManage} />

      <div className="bg-hud-bg-mid rounded-xl border border-hud-bg-card">
        <div className="p-4 border-b border-hud-bg-card">
          <h3 className="text-lg font-semibold text-white">Departments</h3>
        </div>
        <div className="p-4 space-y-4">
          {canManage && (
            <div className="flex gap-3">
              <input
                type="text"
                value={newDeptName}
                onChange={(e) => setNewDeptName(e.target.value)}
                placeholder="New department name"
                className="flex-1 px-4 py-2 rounded-lg bg-hud-bg-card border border-hud-bg-elev text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold focus:border-transparent"
              />
              <button
                onClick={handleAddDept}
                disabled={!newDeptName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hud-bg-card text-white hover:bg-hud-bg-elev disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
          )}

          <div className="space-y-2">
            {departments.length === 0 ? (
              <p className="text-hud-cream-dim text-sm py-4 text-center">No departments yet</p>
            ) : (
              departments.map((dept) => (
                <div
                  key={dept.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-hud-bg-card/50"
                >
                  {editingDept?.id === dept.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editDeptName}
                        onChange={(e) => setEditDeptName(e.target.value)}
                        className="flex-1 px-3 py-1 rounded bg-hud-bg-elev border border-hud-cream-mute text-white focus:outline-none focus:ring-2 focus:ring-hud-gold"
                        autoFocus
                      />
                      <button
                        onClick={handleUpdateDept}
                        className="p-1 rounded hover:bg-hud-bg-elev text-hud-emerald"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditingDept(null);
                          setEditDeptName('');
                        }}
                        className="p-1 rounded hover:bg-hud-bg-elev text-hud-cream-dim"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="text-white">{dept.name}</span>
                      {canManage && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              setEditingDept(dept);
                              setEditDeptName(dept.name);
                            }}
                            className="p-1 rounded hover:bg-hud-bg-elev text-hud-cream-dim"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteDept(dept)}
                            className="p-1 rounded hover:bg-hud-bg-elev text-hud-plum"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
