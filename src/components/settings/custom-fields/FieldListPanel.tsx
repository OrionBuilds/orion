import { useState, useMemo } from 'react';
import {
  Search,
  GripVertical,
  MoreHorizontal,
  Edit,
  Copy,
  ToggleLeft,
  ToggleRight,
  Trash2,
  FolderInput,
  Filter,
  FileText,
  Hash,
  Calendar,
  List,
  CheckSquare,
  Phone,
  Mail,
  Link,
  DollarSign,
  Upload,
  ToggleRight as BoolIcon,
  Radio,
  FolderOpen,
  CheckCircle2,
} from 'lucide-react';
import type { CustomField, CustomFieldGroup, CustomFieldType } from '../../../types';
import { CUSTOM_FIELD_TYPE_LABELS } from '../../../types';
import { AnchoredMenu } from '../../shared/AnchoredMenu';

const FIELD_TYPE_ICONS: Record<CustomFieldType, React.ReactNode> = {
  text: <FileText className="w-4 h-4" />,
  textarea: <FileText className="w-4 h-4" />,
  number: <Hash className="w-4 h-4" />,
  currency: <DollarSign className="w-4 h-4" />,
  date: <Calendar className="w-4 h-4" />,
  datetime: <Calendar className="w-4 h-4" />,
  select: <List className="w-4 h-4" />,
  multi_select: <CheckSquare className="w-4 h-4" />,
  boolean: <BoolIcon className="w-4 h-4" />,
  checkbox: <CheckSquare className="w-4 h-4" />,
  radio: <Radio className="w-4 h-4" />,
  phone: <Phone className="w-4 h-4" />,
  email: <Mail className="w-4 h-4" />,
  url: <Link className="w-4 h-4" />,
  file: <Upload className="w-4 h-4" />,
};

interface FieldListPanelProps {
  fields: CustomField[];
  groups: CustomFieldGroup[];
  selectedGroupId: string | null;
  selectedFieldIds: Set<string>;
  onToggleFieldSelection: (fieldId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onEditField: (field: CustomField) => void;
  onDuplicateField: (field: CustomField) => void;
  onToggleFieldActive: (field: CustomField) => void;
  onDeleteField: (field: CustomField) => void;
  onMoveField: (field: CustomField) => void;
  onReorderFields: (fieldIds: string[]) => void;
  canManage: boolean;
  loading?: boolean;
}

export function FieldListPanel({
  fields,
  groups,
  selectedGroupId,
  selectedFieldIds,
  onToggleFieldSelection,
  onSelectAll,
  onClearSelection,
  onEditField,
  onDuplicateField,
  onToggleFieldActive,
  onDeleteField,
  onMoveField,
  onReorderFields,
  canManage,
  loading,
}: FieldListPanelProps) {
  const [search, setSearch] = useState('');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [filterType, setFilterType] = useState<CustomFieldType | 'all'>('all');
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const currentGroup = useMemo(() => {
    if (selectedGroupId === null) return null;
    if (selectedGroupId === 'ungrouped') return { id: 'ungrouped', name: 'Ungrouped Fields', description: null };
    return groups.find((g) => g.id === selectedGroupId) || null;
  }, [selectedGroupId, groups]);

  const filteredFields = useMemo(() => {
    let result = [...fields];

    if (search.trim()) {
      const searchLower = search.toLowerCase();
      result = result.filter(
        (f) =>
          f.name.toLowerCase().includes(searchLower) ||
          f.field_key.toLowerCase().includes(searchLower) ||
          (f.help_text && f.help_text.toLowerCase().includes(searchLower))
      );
    }

    if (filterActive !== 'all') {
      result = result.filter((f) => (filterActive === 'active' ? f.active : !f.active));
    }

    if (filterType !== 'all') {
      result = result.filter((f) => f.field_type === filterType);
    }

    return result;
  }, [fields, search, filterActive, filterType]);

  const allSelected = filteredFields.length > 0 && filteredFields.every((f) => selectedFieldIds.has(f.id));
  const someSelected = filteredFields.some((f) => selectedFieldIds.has(f.id));

  function handleDragStart(e: React.DragEvent, fieldId: string) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', fieldId);
    setDraggedId(fieldId);
  }

  function handleDragOver(e: React.DragEvent, fieldId: string) {
    e.preventDefault();
    if (draggedId && draggedId !== fieldId) {
      setDragOverId(fieldId);
    }
  }

  function handleDragLeave() {
    setDragOverId(null);
  }

  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) return;

    const currentIds = filteredFields.map((f) => f.id);
    const draggedIndex = currentIds.indexOf(draggedId);
    const targetIndex = currentIds.indexOf(targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const newIds = [...currentIds];
    newIds.splice(draggedIndex, 1);
    newIds.splice(targetIndex, 0, draggedId);

    onReorderFields(newIds);
    setDraggedId(null);
    setDragOverId(null);
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDragOverId(null);
  }

  const groupTitle = selectedGroupId === null
    ? 'All Fields'
    : currentGroup?.name || 'Fields';

  const groupDescription = currentGroup && 'description' in currentGroup ? currentGroup.description : null;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-hud-bg-elev bg-hud-bg-card/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              {selectedGroupId && selectedGroupId !== 'ungrouped' && (
                <FolderOpen className="w-5 h-5 text-hud-gold-soft" />
              )}
              {groupTitle}
              <span className="text-sm font-normal text-hud-cream-mute">
                ({filteredFields.length} field{filteredFields.length !== 1 ? 's' : ''})
              </span>
            </h2>
            {groupDescription && (
              <p className="text-sm text-hud-cream-dim mt-0.5">{groupDescription}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[12rem] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-hud-cream-mute" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fields..."
              className="w-full pl-9 pr-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-sm text-white placeholder-hud-cream-dim focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Filter className="w-4 h-4 text-hud-cream-mute" />
            <select
              value={filterActive}
              onChange={(e) => setFilterActive(e.target.value as 'all' | 'active' | 'inactive')}
              className="px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-sm text-white focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>

            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as CustomFieldType | 'all')}
              className="px-3 py-2 bg-hud-bg-card border border-hud-cream-mute rounded-lg text-sm text-white focus:ring-2 focus:ring-hud-gold focus:border-transparent"
            >
              <option value="all">All Types</option>
              {Object.entries(CUSTOM_FIELD_TYPE_LABELS).map(([type, label]) => (
                <option key={type} value={type}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {canManage && filteredFields.length > 0 && (
        <div className="px-6 py-2 border-b border-hud-bg-elev bg-hud-bg-card/30 flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => (allSelected ? onClearSelection() : onSelectAll())}
              className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
            />
            <span className="text-sm text-hud-cream-dim">
              {allSelected ? 'Deselect all' : someSelected ? 'Select all' : 'Select all'}
            </span>
          </label>
          {selectedFieldIds.size > 0 && (
            <span className="text-sm text-hud-gold-soft">
              {selectedFieldIds.size} selected
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filteredFields.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <div className="p-4 bg-hud-bg-card rounded-full mb-4">
              <FileText className="w-8 h-8 text-hud-cream-mute" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">
              {search || filterActive !== 'all' || filterType !== 'all'
                ? 'No fields match your filters'
                : 'No fields yet'}
            </h3>
            <p className="text-hud-cream-dim text-center max-w-md">
              {search || filterActive !== 'all' || filterType !== 'all'
                ? 'Try adjusting your search or filter criteria.'
                : 'Create your first custom field to start collecting additional data.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-hud-bg-elev/50">
            {filteredFields.map((field) => {
              const isSelected = selectedFieldIds.has(field.id);
              const isDragging = draggedId === field.id;
              const isDragOver = dragOverId === field.id;

              return (
                <div
                  key={field.id}
                  draggable={canManage}
                  onDragStart={(e) => handleDragStart(e, field.id)}
                  onDragOver={(e) => handleDragOver(e, field.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, field.id)}
                  onDragEnd={handleDragEnd}
                  className={`
                    flex items-center gap-3 px-6 py-3 transition-all
                    ${isSelected ? 'bg-hud-gold/5' : 'hover:bg-hud-bg-card/50'}
                    ${isDragging ? 'opacity-50' : ''}
                    ${isDragOver ? 'border-t-2 border-hud-gold-soft' : ''}
                    ${!field.active ? 'opacity-60' : ''}
                  `}
                >
                  {canManage && (
                    <>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleFieldSelection(field.id)}
                        className="w-4 h-4 rounded border-hud-cream-mute bg-hud-bg-card text-hud-gold focus:ring-hud-gold focus:ring-offset-hud-bg-mid"
                      />
                      <div className="cursor-grab active:cursor-grabbing p-1 text-hud-cream-mute hover:text-hud-cream-dim">
                        <GripVertical className="w-4 h-4" />
                      </div>
                    </>
                  )}

                  <div className={`p-2 rounded-lg ${field.active ? 'bg-hud-bg-elev' : 'bg-hud-bg-card'}`}>
                    <span className={field.active ? 'text-hud-gold-soft' : 'text-hud-cream-mute'}>
                      {FIELD_TYPE_ICONS[field.field_type]}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">{field.name}</span>
                      {field.is_required && (
                        <span className="px-1.5 py-0.5 text-xs font-medium text-hud-plum bg-hud-plum/20 rounded">
                          Required
                        </span>
                      )}
                      {!field.active && (
                        <span className="px-1.5 py-0.5 text-xs font-medium text-hud-cream-dim bg-hud-bg-elev rounded">
                          Inactive
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs font-mono text-hud-cream-mute">{field.field_key}</span>
                      <span className="text-hud-cream-mute">|</span>
                      <span className="text-xs text-hud-cream-dim">
                        {CUSTOM_FIELD_TYPE_LABELS[field.field_type]}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {field.visible_in_forms && (
                      <span className="p-1 text-hud-cream-mute" title="Available in Forms">
                        <FileText className="w-3.5 h-3.5" />
                      </span>
                    )}
                    {field.visible_in_automations && (
                      <span className="p-1 text-hud-cream-mute" title="Available in Automations">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </div>

                  {canManage && (
                    <div className="relative">
                      <button
                        onClick={() => setMenuOpen(menuOpen === field.id ? null : field.id)}
                        className="p-2 text-hud-cream-mute hover:text-white hover:bg-hud-bg-elev rounded-lg transition-colors"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>

                      {menuOpen === field.id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(null)} />
                          <AnchoredMenu className="w-44 bg-hud-bg-card rounded-lg shadow-xl border border-hud-cream-mute py-1 z-50">
                            <button
                              onClick={() => {
                                onEditField(field);
                                setMenuOpen(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                            >
                              <Edit className="w-4 h-4" />
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                onDuplicateField(field);
                                setMenuOpen(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                            >
                              <Copy className="w-4 h-4" />
                              Duplicate
                            </button>
                            <button
                              onClick={() => {
                                onMoveField(field);
                                setMenuOpen(null);
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-hud-cream-soft hover:bg-hud-bg-elev hover:text-white"
                            >
                              <FolderInput className="w-4 h-4" />
                              Move to Group
                            </button>
                            <button
                              onClick={() => {
                                onToggleFieldActive(field);
                                setMenuOpen(null);
                              }}
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
                              onClick={() => {
                                onDeleteField(field);
                                setMenuOpen(null);
                              }}
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
            })}
          </div>
        )}
      </div>
    </div>
  );
}
