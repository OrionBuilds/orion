import type { Opportunity } from '../../types';
import EntityFilesTab from '../media/EntityFilesTab';

interface OpportunityFilesTabProps {
  opportunity: Opportunity;
  onUpdate: () => void;
}

export default function OpportunityFilesTab({ opportunity, onUpdate }: OpportunityFilesTabProps) {
  return (
    <EntityFilesTab
      entityType="opportunities"
      entityId={opportunity.id}
      organizationId={opportunity.org_id}
      entityLabel="opportunity"
      onUpdate={onUpdate}
    />
  );
}
