import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  // Prototype UI specs remain as historical coverage; the platform has a new navigation contract.
  testMatch: '**/platform*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    viewport: { width: 1512, height: 982 },
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5180',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: false,
    env: { GPT_TEACHER_DATA_DIR: resolve('.test-data', `e2e-${process.pid}`) },
    timeout: 20_000,
  },
});
