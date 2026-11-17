import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailSenderSelect } from './EmailSenderSelect';

const noop = () => {};
const acct = (id: string, email: string, isPrimary = false) => ({ id, email, label: null, isPrimary, status: 'active' });
const render = (props: Partial<Parameters<typeof EmailSenderSelect>[0]>) =>
  renderToStaticMarkup(createElement(EmailSenderSelect, {
    value: 'outlook', onChange: noop, gmailConnected: false, microsoftConnected: true, ...props,
  }));

describe('EmailSenderSelect with Microsoft accounts', () => {
  it('single account: one "My Outlook" entry, no per-account From options', () => {
    const html = render({ microsoftAddress: 'a@x.com', microsoftAccounts: [acct('c1', 'a@x.com', true)] });
    expect(html).toContain('My Outlook');
    expect(html).not.toContain('value="outlook:');
  });

  it('two accounts: one entry per account, the chosen one selected', () => {
    const html = render({
      microsoftAccounts: [acct('c1', 'a@x.com', true), acct('c2', 'b@x.com')],
      microsoftConnectionId: 'c2',
    });
    expect(html).toContain('value="outlook:c1"');
    expect(html).toContain('value="outlook:c2"');
    expect(html).not.toContain('My Outlook');
    expect(html).toMatch(/<option value="outlook:c2" selected/);
  });
});

describe('EmailSenderSelect with Google accounts', () => {
  const gmail = (props: Partial<Parameters<typeof EmailSenderSelect>[0]>) =>
    renderToStaticMarkup(createElement(EmailSenderSelect, {
      value: 'gmail', onChange: noop, gmailConnected: true, ...props,
    }));

  it('single account: one "My Gmail" entry, no per-account From options', () => {
    const html = gmail({ gmailAddress: 'a@gmail.com', googleAccounts: [acct('g1', 'a@gmail.com', true)] });
    expect(html).toContain('My Gmail');
    expect(html).not.toContain('value="gmail:');
  });

  it('no account list (older state): still the single "My Gmail" entry', () => {
    expect(gmail({ gmailAddress: 'a@gmail.com' })).toContain('My Gmail');
  });

  it('two accounts: one Gmail entry per account, the chosen one selected', () => {
    const html = gmail({
      googleAccounts: [acct('g1', 'a@gmail.com', true), acct('g2', 'b@corp.com')],
      googleConnectionId: 'g2',
    });
    expect(html).toContain('value="gmail:g1"');
    expect(html).toContain('value="gmail:g2"');
    expect(html).not.toContain('My Gmail');
    expect(html).toMatch(/<option value="gmail:g2" selected/);
  });

  it('defaults the selection to the primary when none is chosen', () => {
    const html = gmail({ googleAccounts: [acct('g2', 'b@corp.com'), acct('g1', 'a@gmail.com', true)] });
    expect(html).toMatch(/<option value="gmail:g1" selected/);
  });

  it('keeps Outlook and Gmail account lists side by side', () => {
    const html = gmail({
      microsoftConnected: true,
      microsoftAccounts: [acct('c1', 'a@x.com', true), acct('c2', 'b@x.com')],
      googleAccounts: [acct('g1', 'a@gmail.com', true), acct('g2', 'b@corp.com')],
    });
    expect(html).toContain('value="outlook:c1"');
    expect(html).toContain('value="gmail:g2"');
    expect(html).toContain('value="resend"');
  });

  it('does not list Google accounts when Gmail is not connected', () => {
    const html = gmail({ gmailConnected: false, microsoftConnected: true, microsoftAddress: 'a@x.com', googleAccounts: [acct('g1', 'a@gmail.com', true), acct('g2', 'b@corp.com')] });
    expect(html).not.toContain('gmail:');
  });
});
