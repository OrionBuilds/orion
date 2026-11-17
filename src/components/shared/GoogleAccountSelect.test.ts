import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GoogleAccountSelect } from './GoogleAccountSelect';

const noop = () => {};
const acct = (id: string, email: string, isPrimary = false, label: string | null = null) => ({ id, email, label, isPrimary, status: 'active' });

describe('GoogleAccountSelect', () => {
  it('renders nothing for zero or one account', () => {
    expect(renderToStaticMarkup(createElement(GoogleAccountSelect, { accounts: [], value: null, onChange: noop }))).toBe('');
    expect(renderToStaticMarkup(createElement(GoogleAccountSelect, { accounts: [acct('g1', 'a@x.com', true)], value: 'g1', onChange: noop }))).toBe('');
  });

  it('lists accounts with label and Primary, the chosen one selected, and a Google aria label', () => {
    const html = renderToStaticMarkup(createElement(GoogleAccountSelect, {
      accounts: [acct('g1', 'a@x.com', true), acct('g2', 'b@x.com', false, 'Sales')],
      value: 'g2', onChange: noop,
    }));
    expect(html).toContain('Sales (b@x.com)');
    expect(html).toContain('a@x.com - Primary');
    expect(html).toMatch(/<option value="g2" selected/);
    expect(html).toContain('aria-label="Google account"');
  });
});
