import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'mcp-server/dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // The app is dark-themed on the slate-* ramp, but a second gray-* palette has
    // accumulated alongside it (~4,700 uses). Most are invisible -- gray-400 and
    // slate-400 are near-identical -- but the light surfaces are not: bg-white,
    // bg-gray-50 and text-gray-900 inside a dark panel produce genuinely unreadable
    // controls, which is how the selected embed-type button ended up white-on-white.
    //
    // Deliberately a warning, not an error. Turning it red would fail `npm run lint`
    // on thousands of pre-existing lines and teach everyone to ignore the output.
    // The intent is fix-on-touch: you see it on code you are already editing.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/pages/public/**', 'src/components/portal/**'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\b(bg|text|border|ring|divide|placeholder|from|via|to)-gray-\\d{2,3}\\b/]",
          message:
            'Use the slate-* ramp, not gray-*. The app is dark-themed on slate; gray-* is the legacy light palette. (Client portal and public pages are exempt — they are light by design.)',
        },
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\bbg-white\\b/]",
          message:
            'bg-white renders as a light slab inside the dark app. Use bg-slate-800/bg-slate-900, or an alpha tint like bg-blue-500/10. (Client portal and public pages are exempt — they are light by design.)',
        },
      ],
    },
  },
  {
    // Supabase edge functions are typechecked by NOTHING.
    //
    // tsconfig.app.json is `"include": ["src"]`, so `tsc --noEmit` never reads
    // supabase/functions. `vite build` doesn't either. The Supabase CLI bundles with
    // esbuild, which strips types without checking them. There is no CI. A commit that
    // deleted variable declarations but left their usages therefore deployed cleanly and
    // silently killed Clara's inbound SMS reply path -- Deno threw ReferenceError, the
    // handler's own catch swallowed it, and Twilio got a 200.
    //
    // no-undef is the cheap gate for exactly that class. typescript-eslint's recommended
    // config turns it off (tsc is assumed to cover it), which is why this block MUST stay
    // last: in flat config the final matching block wins, and anywhere earlier the rule
    // is silently disabled again.
    files: ['supabase/functions/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        Deno: 'readonly',
        EdgeRuntime: 'readonly',
        // no-undef cannot tell a TypeScript type position from a value, so DOM/fetch
        // type names used in annotations have to be declared or they read as undefined.
        BodyInit: 'readonly',
        RequestInit: 'readonly',
        ResponseInit: 'readonly',
        HeadersInit: 'readonly',
        RequestInfo: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  }
);
