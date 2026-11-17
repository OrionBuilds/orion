import { describe, it, expect } from 'vitest';
import { MOBILE_TABS, visibleTabs, isTabActive } from './MobileTabBar';

describe('MobileTabBar helpers', () => {
  it('hides tabs the user cannot open or whose feature is off', () => {
    const none = visibleTabs(MOBILE_TABS, { hasPermission: () => false, isFeatureEnabled: () => true });
    expect(none.map((t) => t.key)).toEqual(['home']);
    const noCal = visibleTabs(MOBILE_TABS, { hasPermission: () => true, isFeatureEnabled: (f) => f !== 'calendars' });
    expect(noCal.map((t) => t.key)).toEqual(['home', 'clara', 'conversations', 'approvals']);
    expect(visibleTabs(MOBILE_TABS, { hasPermission: () => true, isFeatureEnabled: () => true })).toHaveLength(5);
  });

  it('marks the tab active for its page and nested pages, Home only on /', () => {
    expect(isTabActive('/', '/')).toBe(true);
    expect(isTabActive('/contacts', '/')).toBe(false);
    expect(isTabActive('/contacts/abc', '/contacts')).toBe(true);
    expect(isTabActive('/contactsx', '/contacts')).toBe(false);
  });
});
