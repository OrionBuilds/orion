/**
 * Bridge between the V2 contact-scoped auth and the old per-project
 * portal pages. Reads projectId from the URL, fetches the project +
 * contact + org data from Supabase, constructs a ClientPortalWithProject
 * object that matches the shape the old pages expect, and wraps the
 * child routes in the old ClientPortalProvider.
 */

import { useEffect, useState } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useClientPortalV2 } from '../../contexts/ClientPortalContextV2';
import { fetchProjectBridgeContext, getStoredSession } from '../../services/clientPortal';
import { ClientPortalProvider } from '../../contexts/ClientPortalContext';
import type { ClientPortalWithProject } from '../../services/projectClientPortals';

export function ClientPortalProjectBridge() {
  const { projectId } = useParams<{ projectId: string }>();
  const { state, contact } = useClientPortalV2();
  const navigate = useNavigate();

  const [portal, setPortal] = useState<ClientPortalWithProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'authenticated' || !contact?.contactId || !projectId) return;

    let cancelled = false;

    async function loadProjectPortal() {
      try {
        // One session-authorized call. The previous version read
        // projects/organizations/client_portal_accounts directly with the anon
        // client; every one of those queries returned nothing after F-41 dropped
        // the anon policies (2026-07-30), so this page said "Project not found"
        // for every client on every project. Authorization (including additional
        // POCs via project_contacts) is the edge function's job now — the old
        // client-side `project.contact_id !== contactId` check is gone because it
        // would lock out every non-primary POC.
        const sessionToken = getStoredSession();
        if (!sessionToken) {
          if (!cancelled) setError('Not signed in');
          return;
        }
        const ctxData = await fetchProjectBridgeContext(sessionToken, projectId!);
        if (!ctxData) {
          if (!cancelled) setError('Project not found');
          return;
        }
        const project = ctxData.project as {
          id: string; org_id: string; name: string; status: string;
          description: string | null; start_date: string | null;
          target_end_date: string | null; updated_at: string;
          contact_id: string | null;
          contact?: { id: string; first_name: string; last_name: string; email: string | null; phone?: string | null } | null;
        };

        const portalObj: ClientPortalWithProject = {
          id: ctxData.accountId ?? 'unknown',
          org_id: project.org_id,
          project_id: project.id,
          contact_id: ctxData.contactId,
          portal_token_hash: '',
          portal_token: null,
          status: 'active',
          expires_at: null,
          last_accessed_at: new Date().toISOString(),
          created_by_user_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          project: {
            id: project.id,
            name: project.name,
            status: project.status,
            description: project.description,
            start_date: project.start_date,
            target_end_date: project.target_end_date,
            updated_at: project.updated_at,
            org_id: project.org_id,
            contact_id: project.contact_id,
          },
          contact: (project.contact ?? null) as ClientPortalWithProject['contact'],
          organization: ctxData.organization,
        };

        if (!cancelled) {
          setPortal(portalObj);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadProjectPortal();
    return () => { cancelled = true; };
  }, [state, contact, projectId]);

  useEffect(() => {
    if (state !== 'authenticated') {
      navigate('/client-portal', { replace: true });
    }
  }, [state, navigate]);

  if (state !== 'authenticated') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-hud-gold" />
      </div>
    );
  }

  if (error || !portal) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <p className="text-hud-plum mb-2">{error || 'Failed to load project'}</p>
          <button
            onClick={() => navigate('/client-portal/dashboard')}
            className="text-sm text-hud-gold-soft hover:underline"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <ClientPortalProvider
      portal={portal}
      contactEmail={contact?.contactEmail ?? null}
      lastOtpVerifiedAt={contact?.lastOtpVerifiedAt ?? null}
    >
      <Outlet />
    </ClientPortalProvider>
  );
}
