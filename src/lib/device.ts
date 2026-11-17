/**
 * Device classification for the layout. Decided from the viewport and pointer type, never from the
 * user agent: a narrow desktop window behaves like a phone and an iPad in a desktop-class browser still
 * counts as a touch tablet.
 *
 *   phone    width < 768                                  Galaxy S25 Ultra (~412px)
 *   tablet   768-1279 and a coarse pointer (touch)        iPad Pro 11 (834px portrait, 1194px landscape)
 *   desktop  everything else
 *
 * navMode is what the shell does with that:
 *   drawer   slide-out menu (+ bottom tab bar on phones): phone, tablet portrait, any window under 1024px
 *   rail     64px icon rail that expands over the content: tablet landscape
 *   sidebar  the full collapsible sidebar: desktop
 */
export type DeviceClass = 'phone' | 'tablet' | 'desktop';
export type NavMode = 'drawer' | 'rail' | 'sidebar';
export type Orientation = 'portrait' | 'landscape';

export interface DeviceInfo {
  device: DeviceClass;
  orientation: Orientation;
  navMode: NavMode;
  isTouch: boolean;
  isStandalone: boolean;
  isIOS: boolean;
}

export const PHONE_MAX_WIDTH = 767;
export const TABLET_MAX_WIDTH = 1279;
export const DRAWER_MAX_WIDTH = 1023;

export function classifyDevice(i: { width: number; height: number; coarsePointer: boolean }): Pick<DeviceInfo, 'device' | 'orientation' | 'navMode'> {
  const orientation: Orientation = i.height > i.width ? 'portrait' : 'landscape';
  let device: DeviceClass;
  if (i.width <= PHONE_MAX_WIDTH) device = 'phone';
  else if (i.coarsePointer && i.width <= TABLET_MAX_WIDTH) device = 'tablet';
  else device = 'desktop';

  let navMode: NavMode;
  if (device === 'phone') navMode = 'drawer';
  else if (device === 'tablet') navMode = orientation === 'portrait' ? 'drawer' : 'rail';
  else navMode = i.width <= DRAWER_MAX_WIDTH ? 'drawer' : 'sidebar';
  return { device, orientation, navMode };
}

export const DEFAULT_DEVICE: DeviceInfo = {
  device: 'desktop', orientation: 'landscape', navMode: 'sidebar', isTouch: false, isStandalone: false, isIOS: false,
};

/** Reads the live browser state. Safe where matchMedia does not exist (tests, SSR): returns the desktop default. */
export function readDevice(win: Window | undefined = typeof window === 'undefined' ? undefined : window): DeviceInfo {
  if (!win || typeof win.matchMedia !== 'function') return DEFAULT_DEVICE;
  const mq = (q: string) => win.matchMedia(q).matches;
  const nav = win.navigator as Navigator & { standalone?: boolean; maxTouchPoints?: number };
  const coarse = mq('(pointer: coarse)');
  const ua = nav.userAgent || '';
  // iPadOS reports a Mac user agent; touch points tell it apart. Used only to choose the install instructions.
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  return {
    ...classifyDevice({ width: win.innerWidth, height: win.innerHeight, coarsePointer: coarse }),
    isTouch: mq('(hover: none)') || coarse,
    isStandalone: mq('(display-mode: standalone)') || nav.standalone === true,
    isIOS,
  };
}
