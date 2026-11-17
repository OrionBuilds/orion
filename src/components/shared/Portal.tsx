import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const OVERLAY_ROOT_ID = 'overlay-root';

/**
 * One container at the end of <body>, above the whole app shell. The shell can't contain overlays:
 * `.hud-body > *` is a z-index:2 stacking context (index.css) while the sidebar sits at z-40 on the
 * root, and SettingsLayout/tables add their own layers and overflow clipping. Rendered here, a
 * modal's own z-index only competes with other overlays.
 */
function overlayRoot(): HTMLElement {
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    // Above the shell (sidebar z-40, header z-50); default text colour for anything that used to
    // inherit it from a page wrapper.
    root.className = 'relative z-[100] text-hud-cream';
    document.body.appendChild(root);
  }
  return root;
}

/** Render children into the app-wide overlay layer (modals, drawers, floating menus). */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, overlayRoot());
}
