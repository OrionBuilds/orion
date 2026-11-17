import type { Contact } from '../../types';
import EntityFilesTab from '../media/EntityFilesTab';

interface ContactFilesTabProps {
  contact: Contact;
  onUpdate: () => void;
}

export default function ContactFilesTab({ contact, onUpdate }: ContactFilesTabProps) {
  return (
    <EntityFilesTab
      entityType="contacts"
      entityId={contact.id}
      organizationId={contact.organization_id}
      entityLabel="contact"
      onUpdate={onUpdate}
    />
  );
}
