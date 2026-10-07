// Tests de humo: que las pantallas principales cargan con los datos de demostración y que lo
// básico responde. No modifican datos: se pueden correr contra la BD local de desarrollo.
import { test, expect, type Page } from '@playwright/test';

// Un error de JavaScript sin capturar en cualquier pantalla hace fallar el test
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

test('kanban: el tablero muestra etapas y oportunidades, y la vista de lista también', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/opportunities');
  await expect(page.getByText('Nuevo contacto', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('María José Fernández').first()).toBeVisible();

  await page.getByText('Lista', { exact: true }).click();
  await expect(page.getByText('María José Fernández').first()).toBeVisible();
  await page.getByText('Tablero', { exact: true }).click();
  await expect(page.getByText('Calificando', { exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('bandeja: lista las conversaciones y abre un chat con sus mensajes', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/conversations');
  await expect(page.getByText('Selecciona una conversación')).toBeVisible();
  await page.getByText('Luis Alberto Cabrera').first().click();
  await expect(page.getByPlaceholder(/Escribe un mensaje/)).toBeVisible();
  await expect(page.getByText('Gracias!').last()).toBeVisible();

  // El buscador filtra la lista
  await page.getByPlaceholder('Buscar…').fill('Patricia');
  await expect(page.getByText('Patricia Castillo').first()).toBeVisible();
  await expect(page.getByText('Jorge Montilla')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('contactos: la lista carga y el buscador encuentra un contacto', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/contacts');
  const search = page.getByPlaceholder('Buscar contactos…').first();
  await expect(search).toBeVisible();
  await search.fill('Uzcátegui');
  await expect(page.getByText('Ricardo Uzcátegui').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('las demás pantallas cargan sin errores', async ({ page }) => {
  const errors = watchErrors(page);
  for (const path of ['/dashboard', '/tasks', '/calendar', '/automations', '/settings/team']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator('main')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('sin sesión, una pantalla privada lleva al login', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/opportunities');
  await expect(page).toHaveURL(/\/(login|inicio)/);
  await context.close();
});
