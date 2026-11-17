import { describe, it, expect, beforeEach } from 'vitest';
import { columnLabels, labelCells, tableTooWide, flexOverflows, isLayoutRow, normalizeTitle, enhanceOnce, WRAP_CLASS, startPhoneEnhancers, CARDS_CLASS, DUP_TITLE_CLASS } from './phoneEnhancers';

function table(html: string): HTMLTableElement {
  document.body.innerHTML = `<table>${html}</table>`;
  return document.querySelector('table')!;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('table cards', () => {
  it('labels body cells from the header cells', () => {
    const t = table('<thead><tr><th></th><th>Invoice</th><th>Amount</th></tr></thead><tbody><tr><td><input></td><td>INV-1</td><td>$5</td></tr></tbody>');
    expect(columnLabels(t)).toEqual(['', 'Invoice', 'Amount']);
    labelCells(t);
    const cells = t.querySelectorAll('td');
    expect(cells[0].hasAttribute('data-label')).toBe(false);
    expect(cells[1].getAttribute('data-label')).toBe('Invoice');
    expect(cells[2].getAttribute('data-label')).toBe('Amount');
    expect(cells[0].hasAttribute('data-primary')).toBe(false);
    expect(cells[1].hasAttribute('data-primary')).toBe(true);
    expect(cells[2].hasAttribute('data-primary')).toBe(false);
  });

  it('respects colspan on header and body cells', () => {
    const t = table('<thead><tr><th colspan="2">Name</th><th>Status</th></tr></thead><tbody><tr><td colspan="2">Acme</td><td>Open</td></tr></tbody>');
    labelCells(t);
    const cells = t.querySelectorAll('td');
    expect(cells[0].getAttribute('data-label')).toBe('Name');
    expect(cells[1].getAttribute('data-label')).toBe('Status');
  });

  it('only wide tables qualify (container width vs table width)', () => {
    expect(tableTooWide(700, 380)).toBe(true);
    expect(tableTooWide(380, 380)).toBe(false);
    expect(tableTooWide(381, 380)).toBe(false);
    expect(tableTooWide(500, 0)).toBe(false);
  });
});

describe('card layout hints', () => {
  it('marks long values wide so they span the card, short ones stay two to a row', () => {
    const t = table('<thead><tr><th>Name</th><th>Email</th><th>Stage</th></tr></thead><tbody><tr><td>Acme</td><td>someone.with.a.long.address@example.com</td><td>Open</td></tr></tbody>');
    labelCells(t);
    const c = t.querySelectorAll('td');
    expect(c[0].hasAttribute('data-wide')).toBe(false);
    expect(c[1].hasAttribute('data-wide')).toBe(true);
    expect(c[2].hasAttribute('data-wide')).toBe(false);
  });
});

describe('flex rows', () => {
  it('wraps only overflowing, nowrap, non-scrolling rows', () => {
    expect(flexOverflows(500, 380, 'visible', 'nowrap')).toBe(true);
    expect(flexOverflows(380, 380, 'visible', 'nowrap')).toBe(false);
    expect(flexOverflows(500, 380, 'auto', 'nowrap')).toBe(false);
    expect(flexOverflows(500, 380, 'visible', 'wrap')).toBe(false);
  });

  it('also catches a content-sized row that runs past the screen edge, but not single-child rows', () => {
    expect(flexOverflows(380, 380, 'visible', 'nowrap', 470, 412, 4)).toBe(true);
    expect(flexOverflows(380, 380, 'visible', 'nowrap', 412, 412, 4)).toBe(false);
    expect(flexOverflows(380, 380, 'visible', 'nowrap', 470, 412, 1)).toBe(false);
  });
});

describe('duplicate page title', () => {
  it('hides the first h1 only when it repeats the app header title', () => {
    document.body.innerHTML = '<header><span data-page-title>Contacts</span></header><main><h1> Contacts </h1><h1>Other</h1></main>';
    enhanceOnce(document.querySelector('main')!);
    const [a, b] = Array.from(document.querySelectorAll('h1'));
    expect(a.classList.contains(DUP_TITLE_CLASS)).toBe(true);
    expect(b.classList.contains(DUP_TITLE_CLASS)).toBe(false);
  });

  it('keeps a different heading', () => {
    document.body.innerHTML = '<header><span data-page-title>Settings</span></header><main><h1>Organization Settings</h1></main>';
    enhanceOnce(document.querySelector('main')!);
    expect(document.querySelector('h1')!.classList.contains(DUP_TITLE_CLASS)).toBe(false);
    expect(normalizeTitle('  A  B ')).toBe('a b');
  });
});

describe('layout rows', () => {
  it('never wraps a row whose panels fill the screen height (Inbox list + thread)', () => {
    document.body.innerHTML = '<main><div class="flex flex-col"><div id="row" class="flex-1 flex min-h-0 min-w-0">'
      + '<div class="flex-1 flex flex-col min-h-0"><div class="overflow-y-auto"></div></div></div>'
      + '<div id="plain" class="flex"><span>a</span><span>b</span></div></div></main>';
    expect(isLayoutRow(document.getElementById('row')!)).toBe(true);
    expect(isLayoutRow(document.getElementById('plain')!)).toBe(false);
    const row = document.getElementById('row')!;
    Object.defineProperty(row, 'scrollWidth', { value: 900 });
    Object.defineProperty(row, 'clientWidth', { value: 412 });
    enhanceOnce(document.querySelector('main') as HTMLElement);
    expect(row.classList.contains(WRAP_CLASS)).toBe(false);
  });
});

describe('startPhoneEnhancers', () => {
  it('removes everything it added when stopped', () => {
    document.body.innerHTML = '<header><span data-page-title>Home</span></header><main><h1>Home</h1></main>';
    const main = document.querySelector('main') as HTMLElement;
    const stop = startPhoneEnhancers(main);
    enhanceOnce(main);
    expect(document.querySelector(`.${DUP_TITLE_CLASS}`)).not.toBeNull();
    stop();
    expect(document.querySelector(`.${DUP_TITLE_CLASS}`)).toBeNull();
    expect(document.querySelector(`.${CARDS_CLASS}`)).toBeNull();
  });
});
