import { describe, it, expect } from 'vitest';
import { installState } from './installPrompt';

describe('installState', () => {
  it('already running as an installed app', () => {
    expect(installState({ standalone: true, hasPrompt: true, isIOS: true })).toBe('installed');
  });
  it('Chrome with a captured install prompt offers the real install button', () => {
    expect(installState({ standalone: false, hasPrompt: true, isIOS: false })).toBe('available');
  });
  it('iPhone/iPad without a prompt gets the Add to Home Screen instructions', () => {
    expect(installState({ standalone: false, hasPrompt: false, isIOS: true })).toBe('ios');
  });
  it('anything else shows nothing', () => {
    expect(installState({ standalone: false, hasPrompt: false, isIOS: false })).toBe('unavailable');
  });
});
