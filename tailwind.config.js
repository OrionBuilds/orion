/** @type {import('tailwindcss').Config} */
// Orion OS colour system (design.md): red primary, teal secondary, orange accent, charcoal neutrals.
const primary = {
  50: '#FEF2F2', 100: '#FEE2E2', 200: '#FECACA', 300: '#FCA5A5', 400: '#F87171',
  500: '#DC2626', 600: '#DC2626', 700: '#B91C1C', 800: '#991B1B', 900: '#7F1D1D', 950: '#450A0A',
};
// Neutrals resolve to CSS variables (src/index.css) so the dark shell gets the charcoal scale and
// public pages keep the light scale; the alpha channel keeps opacity modifiers (bg-gray-900/50) working.
const neutral = (name) =>
  Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => [n, `rgb(var(--bl-${name}-${n}) / <alpha-value>)`]));
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Dark-only HUD shell: `dark:` applies inside the dashboard shell and its overlay layer
  // (src/components/shared/Portal.tsx), not by OS setting (the `media` default gave white panels).
  darkMode: ['variant', '&:where(.hud-body *, #overlay-root *)'],
  theme: {
    extend: {
      // Orion OS palette under the legacy `hud-` names (CSS vars in src/index.css, source of truth
      // design.md). Namespaced so stock slate/cyan/emerald/teal classes keep working mid-migration.
      colors: {
        // Stock accents (blue, sky, indigo) used for buttons, links and focus rings render as brand primary.
        primary,
        blue: primary,
        sky: primary,
        indigo: primary,
        secondary: { 50: '#F0FDFA', 100: '#CCFBF1', 500: '#14B8A6', 600: '#0D9488', 700: '#0F766E' },
        accent: { 50: '#FFF7ED', 100: '#FFEDD5', 500: '#F97316', 600: '#EA580C', 700: '#C2410C' },
        success: { 50: '#F0FDF4', 500: '#22C55E', 700: '#15803D' },
        warning: { 50: '#FFFBEB', 500: '#F59E0B', 700: '#B45309' },
        error: { 50: '#FEF2F2', 500: '#EF4444', 700: '#B91C1C' },
        gray: neutral('gray'),
        slate: neutral('slate'),
        'hud-bg-deep': 'rgb(var(--hud-bg-deep-rgb) / <alpha-value>)',
        'hud-bg-mid': 'rgb(var(--hud-bg-mid-rgb) / <alpha-value>)',
        'hud-bg-card': 'rgb(var(--hud-bg-card-rgb) / <alpha-value>)',
        'hud-bg-elev': 'rgb(var(--hud-bg-elev-rgb) / <alpha-value>)',
        'hud-cream': {
          DEFAULT: 'rgb(var(--hud-cream-rgb) / <alpha-value>)',
          soft: 'rgb(var(--hud-cream-soft-rgb) / <alpha-value>)',
          dim: 'rgb(var(--hud-cream-dim-rgb) / <alpha-value>)',
          mute: 'rgb(var(--hud-cream-mute-rgb) / <alpha-value>)',
        },
        'hud-gold': {
          DEFAULT: 'rgb(var(--hud-gold-rgb) / <alpha-value>)',
          soft: 'rgb(var(--hud-gold-soft-rgb) / <alpha-value>)',
          deep: 'rgb(var(--hud-gold-deep-rgb) / <alpha-value>)',
        },
        'hud-teal': 'rgb(var(--hud-teal-rgb) / <alpha-value>)',
        'hud-emerald': {
          DEFAULT: 'rgb(var(--hud-emerald-rgb) / <alpha-value>)',
          dim: 'rgb(var(--hud-emerald-dim-rgb) / <alpha-value>)',
        },
        'hud-plum': 'rgb(var(--hud-plum-rgb) / <alpha-value>)',
        'hud-rust': 'rgb(var(--hud-rust-rgb) / <alpha-value>)',
        'hud-line': {
          DEFAULT: 'var(--hud-line)',
          soft: 'var(--hud-line-soft)',
          deep: 'var(--hud-line-deep)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        'hud-mono': ['Cascadia Code', 'JetBrains Mono', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'hud-1': 'var(--hud-shadow-1)',
        'hud-2': 'var(--hud-shadow-2)',
      },
    },
  },
  plugins: [],
};
