import { forwardRef, useLayoutEffect, useRef, type ReactNode } from 'react';

const GAP = 4;
const MARGIN = 8;

/**
 * A dropdown panel pinned to its trigger's container (the element it renders inside) with
 * position: fixed, so table wrappers with overflow-hidden / overflow-x-auto can't clip it.
 * Opens below and right-aligned; flips above when it wouldn't fit; stays inside the viewport;
 * follows the anchor on scroll/resize. It stays in place in the DOM, so the owner's existing
 * click-outside / close logic keeps working unchanged (a forwarded ref still points at the panel).
 */
export const AnchoredMenu = forwardRef<HTMLDivElement, { className?: string; children: ReactNode }>(function AnchoredMenu(
  { className, children },
  forwardedRef,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = (node: HTMLDivElement | null) => {
    ref.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const place = () => {
      // An ancestor with transform / filter / backdrop-filter becomes the containing block for
      // fixed elements; measure where (0,0) really lands and correct by that offset.
      el.style.top = '0px';
      el.style.left = '0px';
      const origin = el.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const below = a.bottom + GAP;
      const top = below + origin.height <= window.innerHeight - MARGIN
        ? below
        : Math.max(MARGIN, a.top - GAP - origin.height);
      const left = Math.min(Math.max(MARGIN, a.right - origin.width), window.innerWidth - origin.width - MARGIN);
      el.style.top = `${top - origin.top}px`;
      el.style.left = `${left - origin.left}px`;
      el.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, []);

  return (
    <div ref={setRef} className={className} style={{ position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}>
      {children}
    </div>
  );
});
