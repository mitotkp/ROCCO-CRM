// Tests de humo de la web (Playwright): login, kanban, bandeja y contactos contra el CRM real.
// Necesitan la BD local con los datos de demostración (`node --env-file=.env scripts/seed-demo.ts`
// en server/). Si la API y la web ya están levantadas las reutiliza; si no, las arranca.
//
//   npm run e2e                 # en web/
//   E2E_BASE_URL=… npm run e2e  # contra otra instancia (nunca producción: inicia sesión de verdad)
import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5175';
const external = !!process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, locale: 'es', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    // Un solo inicio de sesión para todos los tests (el login tiene límite de intentos por IP)
    { name: 'sesion', testMatch: /sesion\.setup\.ts/ },
    { name: 'humo', dependencies: ['sesion'], use: { storageState: 'e2e/.auth/sesion.json' } },
  ],
  webServer: external ? undefined : [
    {
      command: 'node --env-file=.env src/index.ts',
      cwd: '../server',
      url: 'http://localhost:3100/api/health',
      reuseExistingServer: true,
      env: { DISABLE_BACKGROUND_JOBS: 'true' },
    },
    { command: 'npm run dev', url: baseURL, reuseExistingServer: true },
  ],
});
