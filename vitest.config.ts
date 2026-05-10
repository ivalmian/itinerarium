import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Coverage instrumentation slows large iteration tests; the default
    // 5s timeout is fine for normal runs but trips a few demographic
    // tests that loop 100k cohorts. 30s gives ample headroom for both.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      // json-summary: machine-readable totals for the watchdog to parse.
      // text: human-readable summary in console.
      // html: drill-down report in coverage/index.html.
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli/**', 'src/ui/**'],
      reportsDirectory: 'coverage',
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
