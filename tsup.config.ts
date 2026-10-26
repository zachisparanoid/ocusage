import { chmodSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  minify: false,
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: async () => {
    // Mark the emitted entry point executable. A no-op on platforms without
    // POSIX permission bits (Windows resolves `bin` entries via npm's own
    // generated shim instead), so this stays safe everywhere.
    try {
      chmodSync('dist/cli.js', 0o755);
    } catch {
      // best effort
    }
  },
});
