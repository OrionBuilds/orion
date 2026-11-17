/**
 * Phone-only layout healing for a desktop-first codebase (about 60 hand-rolled tables, dozens of header rows that were
 * never given flex-wrap). Run on <main> while the device is a phone:
 *   - a flex row whose children overflow it wraps instead of clipping off the right edge,
 *   - a table wider than its container becomes a stack of cards (labels come from the header cells),
 *   - a page heading that repeats the title already shown in the app header is hidden.
 * Opt a table out with data-no-cards, a flex row out with data-no-wrap. Everything is class based and removed again
 * when leaving the phone layout (stopPhoneEnhancers).
 */
export const WRAP_CLASS = 'phone-wrap';
export const CARDS_CLASS = 'phone-cards';
export const DUP_TITLE_CLASS = 'phone-dup-title';
export const WIDE_CELL_CHARS = 26;

/** Header cell text per column, repeating for colspans, so each body cell can show what it is. */
export function columnLabels(table: HTMLTableElement): string[] {
  const head = table.tHead?.rows[0] ?? table.querySelector('thead tr') as HTMLTableRowElement | null;
  if (!head) return [];
  const labels: string[] = [];
  for (const th of Array.from(head.cells)) {
    const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.max(1, th.colSpan); i++) labels.push(text);
  }
  return labels;
}

export function labelCells(table: HTMLTableElement): void {
  const labels = columnLabels(table);
  for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
    let col = 0;
    let primarySet = false;
    for (const cell of Array.from((row as HTMLTableRowElement).cells)) {
      const label = labels[col] ?? '';
      if (label) cell.setAttribute('data-label', label); else cell.removeAttribute('data-label');
      // Long values (emails, titles) take the card's full width; short ones sit two to a row.
      if ((cell.textContent ?? '').trim().length > WIDE_CELL_CHARS) cell.setAttribute('data-wide', ''); else cell.removeAttribute('data-wide');
      // The first labelled cell (name, proposal, invoice...) is the card's title.
      if (label && !primarySet && cell.colSpan === 1) { cell.setAttribute('data-primary', ''); primarySet = true; }
      else cell.removeAttribute('data-primary');
      col += Math.max(1, cell.colSpan);
    }
  }
}

/** A table is too wide when it needs more than its container offers (allowing 2px of rounding). */
export function tableTooWide(tableWidth: number, containerWidth: number): boolean {
  return containerWidth > 0 && tableWidth > containerWidth + 2;
}

/**
 * True for rows that overflow, without being an intentional scroller: either their content is wider than their box,
 * or the row itself runs past the right edge of the screen (a row sized by its own content never overflows its own box).
 */
export function flexOverflows(
  scrollWidth: number, clientWidth: number, overflowX: string, flexWrap: string,
  rightEdge = 0, viewportWidth = Number.POSITIVE_INFINITY, childCount = 2,
): boolean {
  if (clientWidth <= 0 || overflowX !== 'visible' || flexWrap !== 'nowrap' || childCount < 2) return false;
  return scrollWidth > clientWidth + 1 || rightEdge > viewportWidth + 1;
}

/**
 * Page-layout rows (a list beside a thread, a board beside a panel) size their children to the screen height. Wrapping
 * one lets those children grow to their full content height, so the scroll area inside never scrolls (the Inbox thread
 * on a phone grew to 17,000px and was clipped). Such rows are left alone; they handle the phone layout themselves.
 */
export const LAYOUT_ROW_SELECTOR = '.min-h-0, .h-full, .h-screen, .h-dvh, [class*="h-[calc"], [class*="max-h-"]';
export function isLayoutRow(el: Element): boolean {
  return el.matches(LAYOUT_ROW_SELECTOR) || !!el.querySelector(':scope > :is(.min-h-0, .h-full)');
}

export function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function enhanceOnce(main: HTMLElement): void {
  const title = normalizeTitle(document.querySelector('[data-page-title]')?.textContent ?? '');

  // 1. Duplicate headings. Only the first h1 on the page, only when it says exactly what the app header says.
  const h1 = main.querySelector('h1');
  if (h1 && title && normalizeTitle(h1.textContent ?? '') === title) h1.classList.add(DUP_TITLE_CLASS);

  // 2. Wide tables become cards (measured first, so tables that fit stay tables).
  for (const table of Array.from(main.querySelectorAll('table'))) {
    if (table.hasAttribute('data-no-cards') || table.classList.contains(CARDS_CLASS)) continue;
    const container = table.parentElement;
    if (container && tableTooWide(table.offsetWidth, container.clientWidth)) {
      labelCells(table);
      table.classList.add(CARDS_CLASS);
    }
  }
  for (const table of Array.from(main.querySelectorAll(`table.${CARDS_CLASS}`))) labelCells(table as HTMLTableElement); // new rows

  // 3. Overflowing flex rows wrap.
  for (const el of Array.from(main.querySelectorAll<HTMLElement>('.flex:not(.flex-col):not(.flex-wrap)'))) {
    if (el.classList.contains(WRAP_CLASS) || el.hasAttribute('data-no-wrap') || el.closest('table')) continue;
    if (el.closest('.overflow-x-auto, .overflow-x-scroll, .snap-x-row')) continue; // intentional horizontal scrollers (tab strips, boards)
    if (isLayoutRow(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.flexDirection !== 'row') continue;
    if (flexOverflows(el.scrollWidth, el.clientWidth, cs.overflowX, cs.flexWrap, el.getBoundingClientRect().right, window.innerWidth, el.childElementCount)) {
      el.classList.add(WRAP_CLASS);
    }
  }
}

/** Observe <main> and keep it healed while it changes. Returns the stop function. */
export function startPhoneEnhancers(main: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try { enhanceOnce(main); } catch (e) { console.warn('[phone] enhance failed:', e); }
    }, 250);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(main, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    if (timer) clearTimeout(timer);
    for (const cls of [WRAP_CLASS, CARDS_CLASS, DUP_TITLE_CLASS]) {
      for (const el of Array.from(main.querySelectorAll(`.${cls}`))) el.classList.remove(cls);
    }
  };
}
