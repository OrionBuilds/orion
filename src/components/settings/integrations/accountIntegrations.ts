/**
 * Google (Gmail, Calendar, Meet, Drive) and Microsoft 365 are each ONE account connection — the same
 * cards as My Profile → Connected Accounts — so their per-service catalog rows aren't shown as cards
 * on the Integrations tabs.
 */
export const ACCOUNT_INTEGRATION_KEYS = ['gmail', 'google_calendar', 'google_workspace', 'microsoft_365'];

/** Search text that should still surface the Accounts section on All Integrations. */
export const ACCOUNT_SEARCH_TERMS = ['google', 'gmail', 'calendar', 'meet', 'drive', 'workspace', 'microsoft', 'outlook', 'teams', 'sharepoint', 'onedrive', '365'];
