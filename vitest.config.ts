import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Mirror vite.config.ts so components under test that read build-time
  // constants (SettingsModal renders __VC_BUILD_VERSION__) don't ReferenceError.
  define: {
    __VC_BUILD_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: process.env.VITEST
    ? { conditions: ['browser'] }
    : undefined,
});
