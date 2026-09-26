import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/pwa-browser', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5179', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node ../server/tests/fixtures/browserServer.js', url: 'http://127.0.0.1:3009/api/health', reuseExistingServer: false },
    { command: 'npm run build && npm run preview -- --config vite.pwa-test.config.ts --host 127.0.0.1 --port 5179 --strictPort',
      url: 'http://127.0.0.1:5179', env: { VITE_API_BASE_URL: '/' }, timeout: 120000, reuseExistingServer: false },
  ],
});
