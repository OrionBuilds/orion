export * from './enums';
export * from './permissions';
export * from './eventTypes';

/** Public URL of this app (signing links etc.); defaults to the origin it is served from. */
export const APP_BASE_URL: string =
  import.meta.env.VITE_APP_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : '');
