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
  // 四个日常页的入口（与版式无关的稳定语义名；#31 起手机版是底部胶囊、平板版是侧边导航）
  await expect(page.getByTestId('main-nav').first()).toBeVisible();

  // 前端 → API 的通道确实通了（health 用注入的时钟，返回 200 才会显示「服务正常」）
  await expect(page.getByTestId('health-ok')).toHaveText('服务正常');

  // 不出现横向滚动：对**当前视口**断言（#31 起这个 spec 也在平板尺寸下跑）
  const viewport = page.viewportSize()!;
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(viewport.width);
});
