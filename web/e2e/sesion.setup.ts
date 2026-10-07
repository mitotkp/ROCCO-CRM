// Inicia sesión una vez con la cuenta de demostración (server/scripts/seed-demo.ts) y guarda la
// sesión para el resto de tests.
import { test as setup, expect } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL ?? 'valentina@solcaribe.example';
const PASSWORD = process.env.E2E_PASSWORD ?? 'demo-rocco-2026';

setup('iniciar sesión', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('correo@empresa.com').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.context().storageState({ path: 'e2e/.auth/sesion.json' });
});
