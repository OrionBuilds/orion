import { describe, expect, it } from 'vitest';
import { getGoogleErrorMessage, isGoogleAuthError } from './googleAuthErrors';

describe('isGoogleAuthError', () => {
  it('matches known auth failure phrases regardless of case', () => {
    expect(isGoogleAuthError('Unauthorized')).toBe(true);
    expect(isGoogleAuthError('Request failed with status 401')).toBe(true);
    expect(isGoogleAuthError('JWT expired at 2026-01-01')).toBe(true);
    expect(isGoogleAuthError('No active session')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isGoogleAuthError('Network timeout')).toBe(false);
    expect(isGoogleAuthError('')).toBe(false);
  });
});

describe('getGoogleErrorMessage', () => {
  it('returns a reconnect prompt labelled per module for auth errors', () => {
    expect(getGoogleErrorMessage('jwt expired', 'gmail')).toEqual({
      title: 'Gmail connection error',
      description:
        'Please reconnect your Google Workspace account in Settings > My Profile > Connected Accounts.',
    });
    expect(getGoogleErrorMessage('unauthorized', 'calendar').title).toBe(
      'Google Calendar connection error'
    );
    expect(getGoogleErrorMessage('unauthorized').title).toBe('Google connection error');
  });

  it('returns a module-specific generic failure for non-auth errors', () => {
    expect(getGoogleErrorMessage('rate limited', 'drive')).toEqual({
      title: 'Drive operation failed',
      description: 'Please check your connection and try again.',
    });
    expect(getGoogleErrorMessage('rate limited', 'chat').title).toBe('Chat message failed');
    expect(getGoogleErrorMessage('rate limited').title).toBe('Operation failed');
  });
});
