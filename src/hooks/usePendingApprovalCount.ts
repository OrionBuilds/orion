import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { getPendingApprovalCount } from '../services/workflowApprovals';

/** How many agent actions are waiting for the owner's approval (live: refetches when the queue changes). */
export function usePendingApprovalCount(enabled = true) {
  const { user } = useAuth();
  const orgId = user?.organization_id;
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!orgId || !enabled) return;
    try {
      setCount(await getPendingApprovalCount(orgId));
    } catch {
      /* the badge is advisory: keep the last number */
    }
  }, [orgId, enabled]);

  useEffect(() => {
    refresh();
    if (!orgId || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 500);
    };
    const channel = supabase
      .channel(`approvals:${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workflow_approval_queue', filter: `org_id=eq.${orgId}` }, debounced)
      .subscribe();
    const poll = setInterval(refresh, 120_000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      channel.unsubscribe();
    };
  }, [orgId, enabled, refresh]);

  return { count, refresh };
}
