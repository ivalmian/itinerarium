import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/**', 'src/ui/**'],
    },
  },
  resolve: {
    alias: {
      '@sim': resolve(__dirname, 'src/sim'),
      '@procgen': resolve(__dirname, 'src/procgen'),
      '@burnin': resolve(__dirname, 'src/burnin'),
    },
  },
});
