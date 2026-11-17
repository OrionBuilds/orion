import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Edit,
  Trash2,
  Copy,
  ToggleLeft,
  ToggleRight,
  GripVertical,
  FolderOpen,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import type { CustomFieldGroup, CustomField, CustomFieldScope } from '../../../types';
import { CUSTOM_FIELD_TYPE_LABELS } from '../../../types';
import {
  softDeleteCustomField,
  duplicateCustomField,
  toggleCustomFieldActive,
  getFieldValueCount,
} from '../../../services/customFields';
import { deleteCustomFieldGroup } from '../../../services/customFieldGroups';
import { DependencyWarningModal } from './DependencyWarningModal';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

interface FieldGroupsPanelProps {
  scope: CustomFieldScope;
  groups: CustomFieldGroup[];
  ungroupedFields: CustomField[];
  canManage: boolean;
  onEditField: (field: CustomField) => void;
  onEditGroup: (group: CustomFieldGroup) => void;
  onRefresh: () => void;
}

export function FieldGroupsPanel({
  scope,
  groups,
  ungroupedFields,
  canManage,
  onEditField,
  onEditGroup,
  onRefresh,
}: FieldGroupsPanelProps) {
  const { user } = useAuth();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(groups.map((g) => g.id))
  );
  const [fieldMenuOpen, setFieldMenuOpen] = useState<string | null>(null);
  const [groupMenuOpen, setGroupMenuOpen] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomField | null>(null);
  const [deleteValueCount, setDeleteValueCount] = useState(0);
  const [deleting, setDeleting] = useState(false);

  function toggleGroupExpanded(groupId: string) {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(groupId)) {
      newExpanded.delete(groupId);
    } else {
      newExpanded.add(groupId);
    }
    setExpandedGroups(newExpanded);
  }

  async function handleDeleteClick(field: CustomField) {
    setFieldMenuOpen(null);
    const count = await getFieldValueCount(field.id, scope);
    setDeleteValueCount(count);
    setDeleteTarget(field);
  }

  async function handleConfirmDelete() {
    if (!user || !deleteTarget) return;

    setDeleting(true);
    try {
      await softDeleteCustomField(deleteTarget.id, user);
      onRefresh();
    } catch (err) {
      console.error('Failed to delete field:', err);
      alert('Failed to delete field');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function handleDuplicateField(field: CustomField) {
    if (!user) return;

    try {
      await duplicateCustomField(field.id, user);
      onRefresh();
    } catch (err) {
      console.error('Failed to duplicate field:', err);
      alert('Failed to duplicate field');
    }
    setFieldMenuOpen(null);
  }

  async function handleToggleFieldActive(field: CustomField) {
    if (!user) return;

    try {
      await toggleCustomFieldActive(field.id, !field.active, user);
      onRefresh();
    } catch (err) {
      console.error('Failed to toggle field:', err);
      alert('Failed to update field');
    }
    setFieldMenuOpen(null);
  }

  async function handleDeleteGroup(group: CustomFieldGroup) {
    if (!user) return;

    const fieldCount = group.fields?.length || 0;
    if (fieldCount > 0) {
      alert(
        `Cannot delete group "${group.name}" because it contains ${fieldCount} field(s). Move or delete the fields first.`
      );
      return;
    }

    if (!confirm(`Are you sure you want to delete the group "${group.name}"?`)) return;

    try {
      await deleteCustomFieldGroup(group.id, user);
      onRefresh();
    } catch (err) {
      console.error('Failed to delete group:', err);
      alert('Failed to delete group');
    }
    setGroupMenuOpen(null);
  }

  function renderField(field: CustomField) {
    return (
      <div
        key={field.id}
        className={`flex items-center justify-between px-4 py-3 border-b border-hud-bg-elev last:border-b-0 hover:bg-hud-bg-elev/30 transition-colors ${
          !field.active ? 'opacity-50' : ''
        }`}
      >
        <div className="flex items-center gap-3">
          {canManage && (
            <GripVertical className="w-4 h-4 text-hud-cream-mute cursor-move hover:text-hud-cream-dim" />
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">{field.name}</span>
              {field.is_required && (
                <span className="px-1.5 py-0.5 text-xs font-medium text-hud-plum bg-hud-plum/20 rounded">
                  Required
                </span>
              )}
              {!field.active && (
                <span className="px-1.5 py-0.5 text-xs font-medium text-hud-cream-dim bg-hud-cream-mute rounded">
                  Inactive
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-sm text-hud-cream-mute">
              <span className="font-mono text-xs text-hud-cream-dim">{field.field_key}</span>
              <span className="text-hud-cream-mute">|</span>
              <span>{CUSTOM_FIELD_TYPE_LABELS[field.field_type]}</span>
            </div>
          </div>
        </div>
        {canManage && (
          <div className="relative">
            <button
              onClick={() => setFieldMenuOpen(fieldMenuOpen === field.id ? null : field.id)}
              className="p-1.5 text-hud-cream-mute hover:text-white hover:bg-hud-bg-elev rounded transition-colors"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {fieldMenuOpen === field.id && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setFieldMenuOpen(null)}
                />
                <AnchoredMenu className="w-40 bg-hud-bg-card rounded-lg shadow-lg border border-hud-cream-mute py-1 z-50">
                  <button
                    onClick={() => {
                      onEditField(field);
                      setFieldMenuOpen(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                  >
                    <Edit className="w-4 h-4" />
                    Edit
                  </button>
                  <button
                    onClick={() => handleDuplicateField(field)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                  >
                    <Copy className="w-4 h-4" />
                    Duplicate
                  </button>
                  <button
                    onClick={() => handleToggleFieldActive(field)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                  >
                    {field.active ? (
                      <>
                        <ToggleLeft className="w-4 h-4" />
                        Disable
                      </>
                    ) : (
                      <>
                        <ToggleRight className="w-4 h-4" />
                        Enable
                      </>
                    )}
                  </button>
                  <hr className="my-1 border-hud-bg-elev" />
                  <button
                    onClick={() => handleDeleteClick(field)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-plum hover:bg-hud-plum/10"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </button>
                </AnchoredMenu>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderGroup(group: CustomFieldGroup) {
    const isExpanded = expandedGroups.has(group.id);
    const fields = group.fields || [];

    return (
      <div key={group.id} className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-3 bg-hud-bg-elev/50 cursor-pointer hover:bg-hud-bg-elev/70 transition-colors"
          onClick={() => toggleGroupExpanded(group.id)}
        >
          <div className="flex items-center gap-3">
            {canManage && (
              <GripVertical className="w-4 h-4 text-hud-cream-mute cursor-move hover:text-hud-cream-soft" />
            )}
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-hud-cream-dim" />
            ) : (
              <ChevronRight className="w-4 h-4 text-hud-cream-dim" />
            )}
            <span className="font-medium text-white">{group.name}</span>
            <span className="text-sm text-hud-cream-mute">({fields.length} fields)</span>
          </div>
          {canManage && (
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => setGroupMenuOpen(groupMenuOpen === group.id ? null : group.id)}
                className="p-1.5 text-hud-cream-mute hover:text-white hover:bg-hud-cream-mute rounded transition-colors"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {groupMenuOpen === group.id && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setGroupMenuOpen(null)}
                  />
                  <AnchoredMenu className="w-40 bg-hud-bg-card rounded-lg shadow-lg border border-hud-cream-mute py-1 z-50">
                    <button
                      onClick={() => {
                        onEditGroup(group);
                        setGroupMenuOpen(null);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                    >
                      <Edit className="w-4 h-4" />
                      Edit Group
                    </button>
                    <hr className="my-1 border-hud-bg-elev" />
                    <button
                      onClick={() => handleDeleteGroup(group)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-plum hover:bg-hud-plum/10"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete Group
                    </button>
                  </AnchoredMenu>
                </>
              )}
            </div>
          )}
        </div>
        {isExpanded && (
          <div>
            {fields.length === 0 ? (
              <div className="px-4 py-8 text-center text-hud-cream-mute">
                No fields in this group
              </div>
            ) : (
              fields.map(renderField)
            )}
          </div>
        )}
      </div>
    );
  }

  const hasAnyFields = groups.some((g) => (g.fields?.length || 0) > 0) || ungroupedFields.length > 0;

  if (!hasAnyFields && groups.length === 0) {
    return (
      <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev p-12 text-center">
        <div className="flex justify-center mb-4">
          <div className="p-4 bg-hud-bg-elev rounded-full">
            <FolderOpen className="w-8 h-8 text-hud-cream-dim" />
          </div>
        </div>
        <h3 className="text-lg font-medium text-white mb-2">No custom fields yet</h3>
        <p className="text-hud-cream-dim mb-6 max-w-md mx-auto">
          Create custom fields to capture additional information specific to your business needs.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {groups.map(renderGroup)}

        {ungroupedFields.length > 0 && (
          <div className="bg-hud-bg-card rounded-lg border border-hud-bg-elev overflow-hidden">
            <div className="px-4 py-3 bg-hud-bg-elev/50 border-b border-hud-bg-elev">
              <span className="font-medium text-hud-cream-dim">Ungrouped Fields</span>
              <span className="text-sm text-hud-cream-mute ml-2">
                ({ungroupedFields.length} fields)
              </span>
            </div>
            <div>{ungroupedFields.map(renderField)}</div>
          </div>
        )}
      </div>

      {deleteTarget && (
        <DependencyWarningModal
          field={deleteTarget}
          valueCount={deleteValueCount}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
          deleting={deleting}
        />
      )}
    </>
  );
}
