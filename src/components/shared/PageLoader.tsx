/**
 * Route-level loading fallback.
 *
 * Tabbed layouts (Projects, Opportunities, AI Agents, …) render their chrome immediately
 * and their route content through an <Outlet />. Without a Suspense boundary at that
 * Outlet, a lazily-loaded child suspends all the way up to the app-level boundary — which
 * is already past — so the content area just sits blank under a fully-painted toolbar.
 * That reads as "this page is broken" rather than "this page is loading".
 */
export function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hud-gold" />
    </div>
  );
}
