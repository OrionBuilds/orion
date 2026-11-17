import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_DEVICE, readDevice, type DeviceInfo } from '../lib/device';

const DeviceContext = createContext<DeviceInfo>(DEFAULT_DEVICE);

const same = (a: DeviceInfo, b: DeviceInfo) =>
  a.device === b.device && a.orientation === b.orientation && a.navMode === b.navMode &&
  a.isTouch === b.isTouch && a.isStandalone === b.isStandalone && a.isIOS === b.isIOS;

/** Tracks the device class and mirrors it onto <html data-*> so CSS can adapt (see index.css). */
export function DeviceProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<DeviceInfo>(() => readDevice());

  useEffect(() => {
    const update = () => setInfo((prev) => {
      const next = readDevice();
      return same(prev, next) ? prev : next;
    });
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.dataset.device = info.device;
    el.dataset.orientation = info.orientation;
    el.dataset.nav = info.navMode;
    el.dataset.touch = String(info.isTouch);
    el.dataset.standalone = String(info.isStandalone);
  }, [info]);

  return <DeviceContext.Provider value={info}>{children}</DeviceContext.Provider>;
}

/** Without a provider (tests) this is the desktop default. */
export function useDevice(): DeviceInfo {
  return useContext(DeviceContext);
}
