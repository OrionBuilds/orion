import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MicrosoftAccountSelect } from './MicrosoftAccountSelect';

const noop = () => {};
const acct = (id: string, email: string, isPrimary = false, label: string | null = null) => ({ id, email, label, isPrimary, status: 'active' });

describe('MicrosoftAccountSelect', () => {
  it('renders nothing for zero or one account', () => {
    expect(renderToStaticMarkup(createElement(MicrosoftAccountSelect, { accounts: [], value: null, onChange: noop }))).toBe('');
    expect(renderToStaticMarkup(createElement(MicrosoftAccountSelect, { accounts: [acct('c1', 'a@x.com', true)], value: 'c1', onChange: noop }))).toBe('');
  });

  it('lists accounts with label and Primary, plus the optional none entry', () => {
    const html = renderToStaticMarkup(createElement(MicrosoftAccountSelect, {
      accounts: [acct('c1', 'a@x.com', true), acct('c2', 'b@x.com', false, 'Sales')],
      value: 'c1', onChange: noop, noneLabel: "Don't add",
    }));
    expect(html).toContain("Don&#x27;t add");
    expect(html).toContain('Sales (b@x.com)');
    expect(html).toContain('a@x.com - Primary');
  });
});
