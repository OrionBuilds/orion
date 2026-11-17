import { useState, useEffect } from 'react';
import { Search, UserPlus } from 'lucide-react';
import { Drawer } from '../layouts/Drawer';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { createOpportunity } from '../../services/opportunities';
import { getPipelines } from '../../services/pipelines';
import { logActivity } from '../../services/activityLog';
import { InlineCreateContactForm } from '../shared/InlineCreateContactForm';
import type { Pipeline } from '../../types';

interface CreateOpportunityDrawerProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface User {
  id: string;
  name: string;
}

export function CreateOpportunityDrawer({ open, onClose, onSuccess }: CreateOpportunityDrawerProps) {
  const { user } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showNewContactForm, setShowNewContactForm] = useState(false);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<string>('');
  const [selectedStage, setSelectedStage] = useState<string>('');
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [value, setValue] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && user?.organization_id) {
      fetchPipelines();
      fetchUsers();
    }
  }, [open, user?.organization_id]);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setContacts([]);
      setSelectedContact(null);
      setShowNewContactForm(false);
      setSelectedPipeline('');
      setSelectedStage('');
      setAssignedTo('');
      setValue('');
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.length >= 2 && user?.organization_id) {
        searchContacts();
      } else {
        setContacts([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, user?.organization_id]);

  useEffect(() => {
    if (selectedPipeline) {
      const pipeline = pipelines.find((p) => p.id === selectedPipeline);
      if (pipeline?.stages?.length) {
        const sortedStages = [...pipeline.stages].sort((a, b) => a.sort_order - b.sort_order);
        setSelectedStage(sortedStages[0].id);
      }
    }
  }, [selectedPipeline, pipelines]);

  async function fetchPipelines() {
    // Shared RLS-scoped service (same one the working OpportunityModal uses). The old bespoke
    // query here filtered on `organization_id`, but the pipelines table's column is `org_id` —
    // the error was silently swallowed and both dropdowns rendered permanently empty.
    try {
      const data = await getPipelines();
      setPipelines(data);
      if (data.length > 0) {
        setSelectedPipeline(data[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pipelines');
    }
  }

  async function fetchUsers() {
    const { data } = await supabase
      .from('users')
      .select('id, name')
      .eq('organization_id', user?.organization_id)
      .eq('status', 'active')
      .order('name');

    if (data) {
      setUsers(data);
      if (user) {
        setAssignedTo(user.id);
      }
    }
  }

  async function searchContacts() {
    setSearching(true);
    const { data } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email')
      .eq('organization_id', user?.organization_id)
      .eq('status', 'active')
      .or(
        `first_name.ilike.%${searchQuery}%,last_name.ilike.%${searchQuery}%,email.ilike.%${searchQuery}%`
      )
      .limit(10);

    setContacts(data || []);
    setSearching(false);
  }

  async function handleSubmit() {
    if (!user || !user.organization_id || !selectedContact || !selectedPipeline || !selectedStage)
      return;

    setLoading(true);
    setError(null);

    try {
      const opportunity = await createOpportunity({
        org_id: user.organization_id,
        contact_id: selectedContact.id,
        pipeline_id: selectedPipeline,
        stage_id: selectedStage,
        assigned_user_id: assignedTo || null,
        value_amount: value ? parseFloat(value) : 0,
        created_by: user.id,
      });

      await logActivity({
        organizationId: user.organization_id,
        userId: user.id,
        eventType: 'opportunity_created',
        entityType: 'opportunity',
        entityId: opportunity.id,
        contactId: selectedContact.id,
        summary: `Created opportunity for ${selectedContact.first_name} ${selectedContact.last_name}`.trim(),
        payload: { value: value ? parseFloat(value) : 0, pipeline_id: selectedPipeline },
      });

      onSuccess?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create opportunity');
    } finally {
      setLoading(false);
    }
  }

  const currentPipeline = pipelines.find((p) => p.id === selectedPipeline);
  const stages = currentPipeline?.stages?.sort((a, b) => a.sort_order - b.sort_order) || [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Create Opportunity"
      subtitle="Add a new sales opportunity"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-hud-cream-soft hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !selectedContact || !selectedPipeline || !selectedStage}
            className="px-4 py-2 bg-hud-gold hover:bg-hud-gold-deep text-hud-bg-deep text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Creating...' : 'Create Opportunity'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-hud-plum/10 border border-hud-plum/20 rounded-lg text-sm text-hud-plum">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
            Contact <span className="text-hud-plum">*</span>
          </label>
          {selectedContact ? (
            <div className="flex items-center justify-between p-3 bg-hud-bg-card border border-hud-bg-elev rounded-lg">
              <div>
                <p className="text-sm font-medium text-white">
                  {selectedContact.first_name} {selectedContact.last_name}
                </p>
                <p className="text-xs text-hud-cream-dim">{selectedContact.email || 'No email'}</p>
              </div>
              <button
                onClick={() => setSelectedContact(null)}
                className="text-xs text-hud-gold-soft hover:text-hud-gold-soft"
              >
                Change
              </button>
            </div>
          ) : showNewContactForm && user?.organization_id ? (
            <InlineCreateContactForm
              orgId={user.organization_id}
              currentUser={user}
              initialFirstName={searchQuery}
              onCreated={(contact) => {
                setSelectedContact({
                  id: contact.id,
                  first_name: contact.first_name,
                  last_name: contact.last_name ?? '',
                  email: contact.email ?? null,
                });
                setShowNewContactForm(false);
                setSearchQuery('');
                setContacts([]);
              }}
              onCancel={() => setShowNewContactForm(false)}
            />
          ) : (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-hud-cream-mute" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search contacts..."
                className="w-full pl-10 pr-4 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
              />
              {(contacts.length > 0 || searching || searchQuery.length >= 2) && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-hud-bg-card border border-hud-bg-elev rounded-lg shadow-xl z-10 max-h-48 overflow-y-auto">
                  {searching ? (
                    <div className="p-3 text-sm text-hud-cream-dim">Searching...</div>
                  ) : (
                    <>
                      {contacts.map((contact) => (
                        <button
                          key={contact.id}
                          onClick={() => {
                            setSelectedContact(contact);
                            setSearchQuery('');
                            setContacts([]);
                          }}
                          className="w-full p-3 text-left hover:bg-hud-bg-elev transition-colors"
                        >
                          <p className="text-sm font-medium text-white">
                            {contact.first_name} {contact.last_name}
                          </p>
                          <p className="text-xs text-hud-cream-dim">{contact.email || 'No email'}</p>
                        </button>
                      ))}
                      <button
                        onClick={() => setShowNewContactForm(true)}
                        className="w-full p-3 text-left hover:bg-hud-bg-elev transition-colors flex items-center gap-2 border-t border-hud-bg-elev"
                      >
                        <UserPlus className="h-4 w-4 text-hud-gold-soft" />
                        <span className="text-sm font-medium text-hud-gold-soft">
                          Create new contact{searchQuery ? ` “${searchQuery}”` : ''}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              )}
              {searchQuery.length < 2 && (
                <button
                  onClick={() => setShowNewContactForm(true)}
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-hud-gold-soft hover:text-hud-gold transition-colors"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Create new contact
                </button>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
            Pipeline <span className="text-hud-plum">*</span>
          </label>
          <select
            value={selectedPipeline}
            onChange={(e) => setSelectedPipeline(e.target.value)}
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
          >
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">
            Stage <span className="text-hud-plum">*</span>
          </label>
          <select
            value={selectedStage}
            onChange={(e) => setSelectedStage(e.target.value)}
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Value ($)</label>
          <input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
            min="0"
            step="0.01"
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white placeholder-hud-cream-dim focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-hud-cream-soft mb-1.5">Assigned To</label>
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            className="w-full px-3 py-2 bg-hud-bg-card border border-hud-bg-elev rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-hud-gold/40"
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Drawer>
  );
}
