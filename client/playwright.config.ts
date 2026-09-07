import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:5179', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node ../server/tests/fixtures/browserServer.js', url: 'http://127.0.0.1:3009/api/meals', reuseExistingServer: false },
    { command: 'npm run dev -- --host 127.0.0.1 --port 5179 --strictPort', url: 'http://127.0.0.1:5179',
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3009' }, reuseExistingServer: false },
  ],
});
