import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { createContact } from '../../services/contacts';
import type { Contact, User } from '../../types';

interface Props {
  orgId: string;
  currentUser: User;
  initialFirstName?: string;
  onCreated: (contact: Contact) => void;
  onCancel: () => void;
}

export function InlineCreateContactForm({ orgId, currentUser, initialFirstName = '', onCreated, onCancel }: Props) {
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState({
    first_name: initialFirstName,
    last_name: '',
    email: '',
    phone: '',
  });

  async function handleCreate() {
    if (!data.first_name.trim()) return;
    setSaving(true);
    try {
      const contact = await createContact(
        orgId,
        {
          department_id: currentUser.department_id,
          owner_id: currentUser.id,
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim() || undefined,
          email: data.email.trim() || null,
          phone: data.phone.trim() || null,
        },
        currentUser
      );
      onCreated(contact);
    } catch (err) {
      console.error('Failed to create contact:', err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-hud-bg-card border border-hud-bg-elev rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <button
          type="button"
          onClick={onCancel}
          className="p-1 hover:bg-hud-bg-elev rounded transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-hud-cream-dim" />
        </button>
        <span className="text-sm font-medium text-white">New Contact</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-hud-cream-dim mb-1">First Name *</label>
          <input
            type="text"
            value={data.first_name}
            onChange={(e) => setData((p) => ({ ...p, first_name: e.target.value }))}
            placeholder="First name"
            autoFocus
            className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
          />
        </div>
        <div>
          <label className="block text-xs text-hud-cream-dim mb-1">Last Name</label>
          <input
            type="text"
            value={data.last_name}
            onChange={(e) => setData((p) => ({ ...p, last_name: e.target.value }))}
            placeholder="Last name"
            className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-hud-cream-dim mb-1">Email</label>
        <input
          type="email"
          value={data.email}
          onChange={(e) => setData((p) => ({ ...p, email: e.target.value }))}
          placeholder="email@example.com"
          className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
        />
      </div>

      <div>
        <label className="block text-xs text-hud-cream-dim mb-1">Phone</label>
        <input
          type="tel"
          value={data.phone}
          onChange={(e) => setData((p) => ({ ...p, phone: e.target.value }))}
          placeholder="+1 (555) 000-0000"
          className="w-full px-3 py-2 bg-hud-bg-elev border border-hud-cream-mute rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-hud-gold"
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-3 py-2 bg-hud-bg-elev text-hud-cream-soft rounded text-sm hover:bg-hud-cream-mute transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={saving || !data.first_name.trim()}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-hud-gold-deep text-white rounded text-sm hover:bg-hud-gold-deep disabled:opacity-50 transition-colors"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {saving ? 'Creating...' : 'Create & Select'}
        </button>
      </div>
    </div>
  );
}
