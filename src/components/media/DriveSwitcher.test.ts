import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DriveSwitcher, { CONNECT_ACCOUNTS_HREF } from './DriveSwitcher';

const noop = () => {};
const render = (props: Parameters<typeof DriveSwitcher>[0]) => renderToStaticMarkup(createElement(DriveSwitcher, props));

describe('DriveSwitcher', () => {
  it('shows a pressed button for the active connected drive and a switch button for the other', () => {
    const html = render({ active: 'microsoft', onSelect: noop, options: [
          { provider: 'microsoft', connected: true, email: 'a@x.com' },
          { provider: 'google', connected: true, email: 'a@gmail.com' },
        ] });
    expect(html).toContain('SharePoint / OneDrive');
    expect(html).toContain('Google Drive');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
  });

  it('offers a Connect link, not a button, for a drive that is not connected', () => {
    const html = render({ active: 'google', onSelect: noop, options: [
          { provider: 'microsoft', connected: false, email: null },
          { provider: 'google', connected: true, email: 'a@gmail.com' },
        ] });
    expect(html).toContain(`href="${CONNECT_ACCOUNTS_HREF.replace('&', '&amp;')}"`);
    expect(html).toContain('Connect SharePoint / OneDrive');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it('works for a buyer with only one provider', () => {
    const html = render({ active: 'microsoft', onSelect: noop, options: [
        { provider: 'microsoft', connected: true, email: null },
        { provider: 'google', connected: false, email: null },
      ] });
    expect(html).toContain('Connect Google Drive');
  });
});
