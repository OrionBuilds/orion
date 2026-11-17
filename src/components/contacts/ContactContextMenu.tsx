import { useEffect, useRef } from 'react';
import { Edit2, UserCheck, Tag, Archive, Trash2, ExternalLink } from 'lucide-react';
import type { Contact } from '../../types';

interface ContactContextMenuProps {
  contact: Contact;
  position: { x: number; y: number };
  onClose: () => void;
  onEdit: () => void;
  onAssignOwner: () => void;
  onAddTag: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onViewDetail: () => void;
  canEdit: boolean;
  canDelete: boolean;
}

export function ContactContextMenu({
  contact,
  position,
  onClose,
  onEdit,
  onAssignOwner,
  onAddTag,
  onArchive,
  onDelete,
  onViewDetail,
  canEdit,
  canDelete,
}: ContactContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = position.x;
      let adjustedY = position.y;

      if (position.x + rect.width > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 10;
      }

      if (position.y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 10;
      }

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [position]);

  const menuItems = [
    {
      label: 'View Details',
      icon: ExternalLink,
      onClick: onViewDetail,
      show: true,
    },
    {
      label: 'Edit Contact',
      icon: Edit2,
      onClick: onEdit,
      show: canEdit && contact.status === 'active',
    },
    {
      label: 'Assign Owner',
      icon: UserCheck,
      onClick: onAssignOwner,
      show: canEdit && contact.status === 'active',
    },
    {
      label: 'Add Tag',
      icon: Tag,
      onClick: onAddTag,
      show: canEdit && contact.status === 'active',
    },
    {
      label: contact.status === 'active' ? 'Archive' : 'Restore',
      icon: Archive,
      onClick: onArchive,
      show: canEdit,
      divider: true,
    },
    {
      label: 'Delete',
      icon: Trash2,
      onClick: onDelete,
      show: canDelete,
      danger: true,
    },
  ].filter((item) => item.show);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-48 bg-hud-bg-card rounded-lg border border-hud-bg-elev shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 border-b border-hud-bg-elev">
        <p className="text-sm font-medium text-white truncate">
          {contact.first_name} {contact.last_name}
        </p>
        {contact.email && <p className="text-xs text-hud-cream-dim truncate">{contact.email}</p>}
      </div>

      {menuItems.map((item, index) => (
        <div key={item.label}>
          {item.divider && index > 0 && <div className="my-1 border-t border-hud-bg-elev" />}
          <button
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
              item.danger
                ? 'text-hud-plum hover:bg-hud-plum/10'
                : 'text-hud-cream-soft hover:bg-hud-bg-elev'
            }`}
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
