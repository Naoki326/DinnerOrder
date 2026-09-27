import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 菜谱导入：贴链接/贴文字 → AI 结构化 → 预填编辑器（issue #32）。
 *
 * 这个文件只验**单测验不了的那一件事**：这条路在**真界面**里走完的样子——
 * 面板在录入页里、整理结果真的填进了下面的表单、存进库后详情里看得见来源。
 *
 * 为什么全部走「贴文字」而不是「贴链接」：链接那条路要打**外网**（小红书/下厨房），
 * E2E 打外网＝断言依赖「今天平台长什么样」（解析器本身已由 `src/import/extract.test.ts`
 * 用 fixture 离线覆盖）。所以这里的输入全是文字，链接的抓取由单测与人工走查覆盖
 * ——这条边界写在这里，免得后来者以为「链接没测」。
 *
 * ## 收尾纪律（E2E 共用一个库）
 *
 * 与 `recipe-library.spec.ts` 同一纪律：本文件**只碰自己新建的那道菜**，一条种子菜都不动。
 * 库里的痕迹是「导入进来的测试菜」——它进的是家庭菜谱档，会稍微影响推荐池的宽度，
 * 所以名字带票号（出问题时库里的痕迹自报家门）。它**刻意不删**：删掉会让「导入进来的东西
 * 是否真的进了推荐池」这一条失去痕迹，而名字里的票号就是留给后来者的说明。
 */

/** 本文件导入的那道菜：素材里的名字就是它（fake 从素材里读，不编名字） */
const IMPORTED_NAME = '导入测试菜·番茄豆腐煲';

/** 一段像样的素材：够长、含 fake 词表里的若干食材（番茄/豆腐/牛肉/葱/姜/生抽…） */
const SOURCE_TEXT = [
  '导入测试菜·番茄豆腐煲 的做法：',
  '牛肉切薄片，加姜丝、生抽、淀粉抓匀腌 15 分钟。',
  '砂锅下葱爆香，放番茄炒出汁水，铺上豆腐，淋料汁盖盖焖 5 分钟。',
  '最后把牛肉摊开铺上去再焖 3 分钟，撒香菜；能吃辣的加小米辣。',
].join('\n');

/** 打开菜谱库（与 recipe-library.spec.ts 同一条入口路径） */
async function openLibrary(page: Page): Promise<void> {
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-recipes-entry').click();
  await expect(page.getByTestId('recipe-library-view')).toBeVisible({ timeout: 15_000 });
}

/** 从 API 找本文件导入的那道菜 */
async function findImported(
  page: Page,
): Promise<{ id: string; status: string; source: string; sourceRef: string | null; ingredients: { name: string }[] } | undefined> {
  const response = await page.request.get(`${ROOT_URL}/api/recipes?status=all`);
  const { recipes } = (await response.json()) as {
    recipes: {
      id: string;
      name: string;
      status: string;
      source: string;
      sourceRef: string | null;
      ingredients: { name: string }[];
    }[];
  };
  return recipes.find((recipe) => recipe.name === IMPORTED_NAME);
}

/**
 * 第一条（主干）：录入页 → 贴文字 → 整理成菜谱 → 表单被预填 → 保存 → 库里对上。
 *
 * 预填这件事必须验**表单里的值**（不是接口返回的 JSON）：界面的实际用法是把预览塞进
 * `RecipeEditor` 的草稿，塞丢了（字段名对不上、克数没落进输入框）在接口层看不出来。
 */
test('贴文字导入 → 预填编辑器 → 保存进库（含来源回显）', async ({ page }) => {
  await openLibrary(page);

  // 已经导入过（脚本被重跑）：先删掉那条，保证断言是「这次导入的」
  const existing = await findImported(page);
  if (existing) {
    await page.request.post(`${ROOT_URL}/api/recipes/${existing.id}/retire`, { data: {} });
  }

  // 进录入页，导入面板就在上边
  await page.getByTestId('recipe-create-open').click();
  await expect(page.getByTestId('recipe-import-panel')).toBeVisible();

  // 贴文字（切到文字档）→ 整理
  await page.getByTestId('recipe-import-tab-text').click();
  await page.getByTestId('recipe-import-text').fill(SOURCE_TEXT);
  await page.getByTestId('recipe-import-submit').click();

  // 表单被预填：菜名、做法、食材行都落进了输入框
  await expect(page.getByTestId('recipe-name-new')).toHaveValue(IMPORTED_NAME, { timeout: 20_000 });
  await expect(page.getByTestId('recipe-steps-new')).toHaveValue(/腌 15 分钟/);
  await expect(page.getByTestId('recipe-grams-new-0')).not.toHaveValue('');
  // 导入的说明写在面板下方（不是弹层、不是静默）
  await expect(page.getByTestId('recipe-import-notes-new')).toContainText('粘贴的文字');

  // 保存：保存后界面会**切到这道菜的详情态**（`onCreated` → 回到列表并打开它），
  // 所以这里不等那个只存在于「录入态」的「已保存」标记，而是等**真的落库了**这件事
  // （下面那条 `findImported`）——它才是本用例要证明的东西。
  await page.getByTestId('recipe-save-new').click();
  await expect
    .poll(async () => (await findImported(page))?.status, { timeout: 20_000 })
    .toBe('active');

  // 读回来对得上：进的是家庭菜谱档，来源记的是「粘贴的文字」
  const imported = await findImported(page);
  expect(imported).toBeTruthy();
  expect(imported!.source).toBe('oral');
  expect(imported!.sourceRef).toBe('粘贴的文字');
  expect(imported!.ingredients.map((item) => item.name)).toContain('番茄');

  // 详情里看得见来源这一行（可回溯）。
  // 保存后界面**已经在这道菜的详情态**（`onCreated` 回到列表并打开它）——
  // 所以这里没有列表搜索框，也不该先去搜索：本步要证的就是「刚存下的这道菜身上带着来源」。
  await expect(page.getByTestId(`recipe-source-ref-${imported!.id}`)).toContainText('粘贴的文字', {
    timeout: 20_000,
  });
});

/**
 * 第二条：素材太短时说清「要把做法贴全」，而不是让 AI 硬编一道菜。
 */
test('素材太短 → 面板上给一句能照着做的提示，且不产生任何菜谱', async ({ page }) => {
  await openLibrary(page);
  await page.getByTestId('recipe-create-open').click();
  await page.getByTestId('recipe-import-tab-text').click();
  await page.getByTestId('recipe-import-text').fill('牛肉');
  await page.getByTestId('recipe-import-submit').click();

  await expect(page.getByTestId('recipe-import-error')).toBeVisible();
  await expect(page.getByTestId('recipe-import-error')).toContainText('太短');
  // 表单还是空的（没有半截预填，也没有落库）
  await expect(page.getByTestId('recipe-name-new')).toHaveValue('');
});

/**
 * 第三条：链接取不到时，错误信息直接把下一步说出来（改用贴文字），且面板不消失
 * ——它还在同一屏，掌勺者可以立刻切到文字档重来。
 */
test('取不到的链接 → 提示改用贴文字，切过去还能继续', async ({ page }) => {
  await openLibrary(page);
  await page.getByTestId('recipe-create-open').click();
  await page.getByTestId('recipe-import-tab-url').click();
  // 打不通的本地端口：确定性地「取不到」，不依赖外网状态
  await page.getByTestId('recipe-import-url').fill('http://127.0.0.1:9/nope');
  await page.getByTestId('recipe-import-submit').click();

  await expect(page.getByTestId('recipe-import-error')).toBeVisible({ timeout: 20_000 });
  // 断言**具体的下一步**（「可以把做法文字复制出来贴进去」），不只是「贴」这个字——
  // 那个字太宽松：任何把「粘贴」写进文案的失败都会让它通过（实测踩过一次）。
  await expect(page.getByTestId('recipe-import-error')).toContainText('贴进去');

  // 切到文字档：面板还在、错误清掉、能继续用
  await page.getByTestId('recipe-import-tab-text').click();
  await expect(page.getByTestId('recipe-import-text')).toBeVisible();
  await expect(page.getByTestId('recipe-import-panel')).toBeVisible();
});
