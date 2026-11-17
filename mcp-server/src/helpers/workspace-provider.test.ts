import { beforeEach, describe, expect, it, vi } from 'vitest';

const restGet = vi.fn();
vi.mock('./rest-client.js', () => ({ restGet: (...a: unknown[]) => restGet(...a) }));
vi.mock('./pipelineGuard.js', () => ({
  resolveCaller: () => Promise.resolve({ user_id: 'u1', organization_id: 'o1', email: null, role: null, agent_slug: null }),
}));

const m = await import('./workspace-provider.js');

describe('provider normalisation', () => {
  it('maps connected-account provider values', () => {
    expect(m.normalizeAccountProvider('microsoft_365')).toBe('microsoft');
    expect(m.normalizeAccountProvider('google_workspace')).toBe('google');
    expect(m.normalizeAccountProvider('google_gmail')).toBe('google');
    expect(m.normalizeAccountProvider('twilio')).toBeNull();
  });

  it('ignores non-connected rows; Microsoft first; org default breaks ties', () => {
    expect(m.connectedProviders([{ provider: 'microsoft_365', status: 'error' }])).toEqual([]);
    expect(m.connectedProviders([{ provider: 'google_gmail' }, { provider: 'microsoft_365' }])).toEqual(['microsoft', 'google']);
    expect(m.pickProvider(['microsoft', 'google'])).toBe('microsoft');
    expect(m.pickProvider(['microsoft', 'google'], 'google')).toBe('google');
    expect(m.pickProvider(['google'], 'microsoft')).toBe('google');
    expect(m.pickProvider([])).toBeNull();
  });
});

describe('resolveWorkspaceProvider', () => {
  beforeEach(() => restGet.mockReset());

  it('explicit provider passes through without a lookup', async () => {
    expect(await m.resolveWorkspaceProvider('google')).toBe('google');
    expect(restGet).not.toHaveBeenCalled();
  });

  it('auto: single connected provider', async () => {
    restGet.mockResolvedValueOnce([{ provider: 'microsoft_365', status: 'connected' }]);
    expect(await m.resolveWorkspaceProvider('auto')).toBe('microsoft');
    expect(restGet.mock.calls[0][1].filters.user_id).toBe('eq.u1');
  });

  it('auto: both connected follows the org default', async () => {
    restGet
      .mockResolvedValueOnce([{ provider: 'microsoft_365', status: 'connected' }, { provider: 'google_workspace', status: 'connected' }])
      .mockResolvedValueOnce([{ default_workspace_provider: 'google' }]);
    expect(await m.resolveWorkspaceProvider(undefined)).toBe('google');
  });

  it('auto: both connected, org setting unreadable -> Microsoft', async () => {
    restGet
      .mockResolvedValueOnce([{ provider: 'microsoft_365' }, { provider: 'google_gmail' }])
      .mockRejectedValueOnce(new Error('column does not exist'));
    expect(await m.resolveWorkspaceProvider('auto')).toBe('microsoft');
  });

  it('auto: nothing connected -> clear error', async () => {
    restGet.mockResolvedValueOnce([]);
    await expect(m.resolveWorkspaceProvider('auto')).rejects.toThrow(m.NOT_CONNECTED_MESSAGE);
  });
});

describe('route mapping', () => {
  it('mail: Gmail vs Outlook with action aliases and body normalisation', () => {
    expect(m.mailRoute('google', 'getThread', { threadId: 't' })).toEqual({ slug: 'gmail-api', body: { threadId: 't', action: 'get-thread' } });
    expect(m.mailRoute('google', 'send', { to: 'a@x.com', subject: 's', body: '<p>hi</p>' }).body).toMatchObject({ action: 'send', htmlBody: '<p>hi</p>' });
    expect(m.mailRoute('microsoft', 'send', { to: 'a@x.com', subject: 's', htmlBody: '<p>hi</p>' })).toEqual({
      slug: 'microsoft-mail',
      body: { to: ['a@x.com'], subject: 's', htmlBody: '<p>hi</p>', body: '<p>hi</p>', contentType: 'html', action: 'send' },
    });
    expect(m.mailRoute('microsoft', 'get', { messageId: 'm' }).body).toMatchObject({ action: 'get-message' });
    expect(() => m.mailRoute('microsoft', 'list')).toThrow(/Conversations/);
    expect(() => m.mailRoute('google', 'mark-read')).toThrow(/Gmail does not support/);
  });

  it('files: drive-api vs sharepoint-api', () => {
    expect(m.filesRoute('google', 'share', { fileId: 'f' }).slug).toBe('drive-api');
    expect(m.filesRoute('microsoft', 'createFolder', { name: 'X' })).toEqual({ slug: 'sharepoint-api', body: { name: 'X', action: 'create-folder' } });
    expect(() => m.filesRoute('microsoft', 'share')).toThrow(/SharePoint/);
  });

  it('calendar sync and connect go to user-facing functions only', () => {
    expect(m.calendarSyncRoute('google', true)).toEqual({ slug: 'google-calendar-sync', body: { action: 'sync-incremental' } });
    expect(m.calendarSyncRoute('microsoft', true)).toEqual({ slug: 'microsoft-calendar', body: { action: 'sync' } });
    expect(m.connectRoute('google', { appOrigin: 'https://app' })).toEqual({
      slug: 'google-oauth-unified', method: 'POST', path: 'start', query: { app_origin: 'https://app' },
    });
    expect(m.connectRoute('microsoft').slug).toBe('microsoft-oauth-start');
    expect(m.kebab('listSharedWithMe')).toBe('list-shared-with-me');
  });
});
