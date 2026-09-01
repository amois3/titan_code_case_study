import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Sandbox probes spawn real processes and are slow on cold CI runners.
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
