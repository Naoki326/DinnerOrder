import { expect, test } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 骨架冒烟：打开首页即见 app 壳空态「最近未定餐槽」占位，且前端真的打到了 API。
 * 每验收场景一条端到端（S1–S10）由后续工单按这个形状补。
 */
test('打开首页见 app 壳与「最近未定餐槽」空态占位', async ({ page }) => {
  await page.goto(`${ROOT_URL}/`);

  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.getByTestId('empty-slot')).toBeVisible();
  await expect(page.getByText('最近未定餐槽')).toBeVisible();
  await expect(page.getByTestId('recommend-button')).toBeVisible();
  await expect(page.getByTestId('tab-bar')).toBeVisible();

  // 前端 → API 的通道确实通了（health 用注入的时钟，返回 200 才会显示「服务正常」）
  await expect(page.getByTestId('health-ok')).toHaveText('服务正常');

  // 手机尺寸下不应出现横向滚动
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});
