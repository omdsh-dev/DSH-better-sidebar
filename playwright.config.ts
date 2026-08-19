/**
 * Playwright config for the headless-render mount lane (tests/e2e).
 *
 * This lane does NOT spawn the server itself: `scripts/e2e-mount.sh` boots a
 * real `dsh web` instance (with the npm-packed plugin mounted through the
 * official `dsh plugin add` channel) and injects the base URL through
 * `DSH_E2E_URL`. The spec's job is to render that URL in a headless Chromium
 * and prove the plugin mounts without crashing the shell.
 *
 * Specs are named `*.e2e.ts` (not `*.spec.ts`) so vitest's default include
 * never collects them; vitest.config.ts excludes the directory as well.
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // The lane's specs are named *.e2e.ts (so vitest's default include never
  // collects them); tell Playwright to pick exactly that shape.
  testMatch: '**/*.e2e.ts',
  // A deterministic gate: no retries, one worker, one browser. The whole lane
  // is a crash probe against one server instance, so serial execution keeps
  // the assertions meaningful (a crash would trip the very next check).
  retries: 0,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [
    ['list'],
    // Local debugging artifact; CI uploads the report dir on failure.
    ['html', { open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
