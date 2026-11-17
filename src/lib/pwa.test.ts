import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pub = (p: string) => join(process.cwd(), 'public', p);

describe('web app manifest', () => {
  const m = JSON.parse(readFileSync(pub('site.webmanifest'), 'utf8'));

  it('has what Chrome needs to offer installation', () => {
    expect(m.name).toBeTruthy();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.id).toBe('/');
  });

  it('every icon exists on disk, with 192, 512 and a separate maskable 512', () => {
    for (const icon of m.icons) expect(existsSync(pub(icon.src)), icon.src).toBe(true);
    const by = (size: string, purpose: string) => m.icons.some((i: { sizes: string; purpose: string }) => i.sizes === size && i.purpose === purpose);
    expect(by('192x192', 'any')).toBe(true);
    expect(by('512x512', 'any')).toBe(true);
    expect(by('512x512', 'maskable')).toBe(true);
  });

  it('shortcut icons exist and no icon mixes any+maskable', () => {
    for (const s of m.shortcuts) for (const i of s.icons) expect(existsSync(pub(i.src)), i.src).toBe(true);
    expect(m.icons.every((i: { purpose: string }) => !i.purpose.includes(' '))).toBe(true);
  });

  it('index.html points at files that exist', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('viewport-fit=cover');
    const touch = /rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    expect(touch && existsSync(pub(touch))).toBe(true);
    expect(existsSync(pub('offline.html'))).toBe(true);
  });
});

describe('service worker', () => {
  const sw = readFileSync(pub('sw.js'), 'utf8');
  const hashed = new RegExp(/^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?|png|svg|webp)$/);

  it('only treats hashed bundle files as immutable (not logos in public/assets subfolders)', () => {
    expect(sw).toContain('[A-Za-z0-9_-]{8}');
    expect(hashed.test('/assets/index-Dk3fA9xQ.js')).toBe(true);
    expect(hashed.test('/assets/vendor-react-B1x2C3d4.css')).toBe(true);
    expect(hashed.test('/assets/logo/orion-os-mark.png')).toBe(false);
    expect(hashed.test('/assets/orion-os-mark.png')).toBe(false);
  });

  it('never handles non-GET or cross-origin requests and never caches API paths', () => {
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('url.origin !== self.location.origin');
    expect(sw).not.toContain('supabase');
    expect(sw).not.toContain('/api/');
  });
});
