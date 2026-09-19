import { expect, test } from '@playwright/test';
import { E2E, SUB_PATH_URL } from './test-env';

/**
 * 子路径下的冒烟：同一份构建产物用 BASE_PATH=/dinner 跑起来后，
 * app 壳与 API 前缀双双随之（ADR-0003 的运行时注入，无需重打包）。
 */
test('BASE_PATH=/dinner 下 app 壳可用且 API 跟随子路径', async ({ page }) => {
  const requestedPaths: string[] = [];
  page.on('request', (request) => requestedPaths.push(new URL(request.url()).pathname));

  await page.goto(SUB_PATH_URL);

  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('empty-slot')).toBeVisible();
  await expect(page.getByTestId('health-ok')).toHaveText('服务正常');

  // 注入的 basePath 真的被前端用上了：API 与静态资源都请求在子路径下
  expect(requestedPaths).toContain(`${E2E.subPath.basePath}/api/health`);
  expect(requestedPaths.some((p) => p.startsWith(`${E2E.subPath.basePath}/assets/`))).toBe(true);
  expect(await page.evaluate(() => window.__APP_CONFIG__?.basePath)).toBe(E2E.subPath.basePath);

  // 底部导航切到「买菜」清单页，证明 Router 的 basename 也是对的
  // （用的是页面自己的 testid，而不是 App 壳的：导航换页真的发生了）
  await page.getByRole('link', { name: /买菜/ }).click();
  await expect(page).toHaveURL(`${SUB_PATH_URL}grocery`);
  await expect(page.getByTestId('grocery-view')).toBeVisible();
});
