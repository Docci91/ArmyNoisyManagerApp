// Tests de base du site en ligne (sans se connecter : aucun code n'est utilisé ici).
import { test, expect } from '@playwright/test';

const API_KEY = 'AIzaSyBXhWZf6e7V9mmKhFoG1wJzCKHcbwpj2Qo'; // clé publique, déjà dans index.html
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/armynoisymanagerapp/databases/(default)/documents';

test("l'écran de connexion s'affiche avec les prénoms de l'équipe", async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('');
  await expect(page).toHaveTitle(/ARMY/i);
  await expect(page.locator('#login-screen')).toBeVisible();
  // Les prénoms viennent de la Cloud Function (démarrage à froid : quelques secondes).
  await expect(page.locator('.login-title')).toHaveText(/tom qui/i, { timeout: 30_000 });
  await expect(page.locator('.member-tile').first()).toBeVisible();
  // L'app reste cachée tant qu'on n'est pas connecté.
  await expect(page.locator('#app-root')).toBeHidden();

  expect(errors).toEqual([]);
});

test('choisir un prénom demande le code à 4 chiffres', async ({ page }) => {
  await page.goto('');
  await page.locator('.member-tile').first().click({ timeout: 30_000 });
  await expect(page.locator('#pin-dots span')).toHaveCount(4);
  await expect(page.locator('.login-sub')).toContainText(/code/i);
  await page.locator('#login-back').click();
  await expect(page.locator('.member-tile').first()).toBeVisible();
});

test('les données sont refusées sans connexion', async ({ request }) => {
  for (const path of ['app_data/tasks', 'app_data/member-notes', 'app_data/member-pins', 'stock_items', 'auth_pins', 'fcm_tokens']) {
    const res = await request.get(`${FIRESTORE}/${path}?key=${API_KEY}`);
    expect(res.status(), path).toBe(403);
  }
});
