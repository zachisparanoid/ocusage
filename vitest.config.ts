import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    // Local-time formatting (e.g. "fetched at") must be deterministic across
    // dev machines and CI regardless of their real timezone.
    env: { TZ: 'UTC' },
  },
});
