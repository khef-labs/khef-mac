import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: './tests/global-setup.ts',
    setupFiles: [],
    testTimeout: 30000,
    fileParallelism: false,
    // Vitest v4: poolOptions removed; use top-level thread limits
    maxThreads: 1,
    minThreads: 1,
    // Test reports
    reporters: ['default', 'tap', 'json', 'html'],
    outputFile: {
      tap: './test-results/results.tap',
      json: './test-results/results.json',
      html: './test-results/index.html',
    },
  }
});
