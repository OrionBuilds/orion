import { useAuth } from '../contexts/AuthContext';

/** Non-SuperAdmins who may see payments: comma-separated VITE_PAYMENTS_ALLOWED_EMAILS. */
const PAYMENTS_ALLOWED_EMAILS = String(import.meta.env.VITE_PAYMENTS_ALLOWED_EMAILS ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function usePaymentsAccess(): boolean {
  const { user, isSuperAdmin } = useAuth();
  if (isSuperAdmin) return true;
  if (!user?.email) return false;
  return PAYMENTS_ALLOWED_EMAILS.includes(user.email.toLowerCase());
}
