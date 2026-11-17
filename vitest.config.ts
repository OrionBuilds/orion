import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'mcp-server/src/helpers/*.test.ts', 'mcp-server/src/tools/*.test.ts'],
    env: {
      TZ: 'UTC',
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/utils/**/*.ts', 'src/lib/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
