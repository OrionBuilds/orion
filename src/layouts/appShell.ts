/**
 * Sizing shared between the app shell (DashboardLayout) and the pages that must fill it.
 *
 * DashboardLayout's root is `min-h-screen`, not a fixed height, so `<main>` has no definite
 * height and a page's `h-full` resolves to `auto`: the page grows with its content and the
 * document scrolls. That is fine for ordinary pages, but a kanban board then has nowhere to put
 * a contained scroll area -- the header, stats and column headers scroll away and the tallest
 * column sets the page height.
 *
 * A page that needs contained scrolling (a board, or a layout whose tabs are boards and
 * h-full/inner-scroll pages) sets this height on its root instead, the same way Calendars and
 * Conversations size themselves from the viewport. Its value is the viewport minus the Header
 * (`app-header`: 4rem plus the top safe-area inset, which is 0 outside an installed tablet/phone) and main's vertical padding (`md:p-6`, 2 x 1.5rem), so the page fills main
 * exactly without a document scrollbar. Change it together with those two.
 *
 * md+ only: below md the boards are not shown (Opportunities hides the board toggle, Projects
 * renders a stacked list below lg) and a phone has too little height to pin the module header,
 * so small screens keep the document scroll.
 */
export const FILL_MAIN_HEIGHT_MD = 'md:h-[calc(100dvh-7rem-var(--safe-top))]';
