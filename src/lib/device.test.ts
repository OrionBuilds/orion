import { describe, it, expect } from 'vitest';
import { classifyDevice, readDevice, DEFAULT_DEVICE } from './device';

const c = (width: number, height: number, coarsePointer: boolean) => classifyDevice({ width, height, coarsePointer });

describe('classifyDevice', () => {
  it('Galaxy S25 Ultra portrait and landscape are phones with the drawer', () => {
    expect(c(412, 915, true)).toEqual({ device: 'phone', orientation: 'portrait', navMode: 'drawer' });
    expect(c(767, 412, true)).toMatchObject({ device: 'phone', orientation: 'landscape', navMode: 'drawer' });
  });

  it('iPad Pro 11 portrait is a tablet with the drawer, landscape a tablet with the icon rail', () => {
    expect(c(834, 1194, true)).toEqual({ device: 'tablet', orientation: 'portrait', navMode: 'drawer' });
    expect(c(1194, 834, true)).toEqual({ device: 'tablet', orientation: 'landscape', navMode: 'rail' });
  });

  it('desktop gets the full sidebar; a mouse window under 1024px keeps the drawer; a mouse window 768-1023 is still desktop', () => {
    expect(c(1440, 900, false)).toEqual({ device: 'desktop', orientation: 'landscape', navMode: 'sidebar' });
    expect(c(1000, 800, false)).toEqual({ device: 'desktop', orientation: 'landscape', navMode: 'drawer' });
    expect(c(1194, 834, false).device).toBe('desktop');
  });

  it('a wide touch screen (1280+) is desktop', () => {
    expect(c(1366, 1024, true)).toMatchObject({ device: 'desktop', navMode: 'sidebar' });
  });

  it('a narrow desktop window behaves like a phone', () => {
    expect(c(600, 800, false).device).toBe('phone');
  });
});

function fakeWindow(o: { width: number; height: number; media: string[]; ua?: string; touchPoints?: number; standalone?: boolean }) {
  return {
    innerWidth: o.width,
    innerHeight: o.height,
    matchMedia: (q: string) => ({ matches: o.media.includes(q) }),
    navigator: { userAgent: o.ua ?? '', maxTouchPoints: o.touchPoints ?? 0, standalone: o.standalone },
  } as unknown as Window;
}

describe('readDevice', () => {
  it('reads an installed iPad (Mac user agent + touch points) in landscape', () => {
    const d = readDevice(fakeWindow({
      width: 1194, height: 834, media: ['(pointer: coarse)', '(hover: none)'],
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', touchPoints: 5, standalone: true,
    }));
    expect(d).toMatchObject({ device: 'tablet', navMode: 'rail', isTouch: true, isStandalone: true, isIOS: true });
  });

  it('reads an Android phone running in the browser (not installed)', () => {
    const d = readDevice(fakeWindow({ width: 412, height: 915, media: ['(pointer: coarse)'], ua: 'Mozilla/5.0 (Linux; Android 15; SM-S938U)' }));
    expect(d).toMatchObject({ device: 'phone', isTouch: true, isStandalone: false, isIOS: false });
  });

  it('detects display-mode standalone on Android and a real Mac as non-iOS', () => {
    expect(readDevice(fakeWindow({ width: 412, height: 915, media: ['(display-mode: standalone)'] })).isStandalone).toBe(true);
    expect(readDevice(fakeWindow({ width: 1440, height: 900, media: [], ua: 'Macintosh', touchPoints: 0 })).isIOS).toBe(false);
  });

  it('falls back to desktop without matchMedia', () => {
    expect(readDevice({} as Window)).toEqual(DEFAULT_DEVICE);
  });
});
