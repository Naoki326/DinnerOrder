import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 食材字典（issue #34/#35；ADR-0012）：从**只读**变成**能录、能改、能删、看得见**。
 *
 * 这个文件只验**单测验不了的两件事**（issue 的 Testing Decisions 点名）：
 *   1. **入口路径本身**：设置 → 食材字典 → 列表 → 「← 设置」返回，含 `hideNav` 壳的形态。
 *   2. **「新建 → 搜索命中 → 删除」与「改食材 → 台账 → 改名跟随」这两条跨层活路径**：
 *      界面上录/改的食材真的落库、真能被搜索命中、改写台账真的显示出来——
 *      单测各验一半会得到两条都过、合起来错的假绿。
 *
 * ## 收尾纪律（E2E 共用一个库）
 *
 * 本 spec 按字母序排在 `meal` 之前，**远早于** `recommend` / `replace` / `review` 这三份依赖种子池的
 * spec。所以本文件只碰**自己新建的条目**（名字带票号 `34-` / `35-`，出问题时库里的痕迹自报家门），
 * 并在收尾时**用自己的删除功能把它们真删掉**（都是零引用，删得掉）。
 *
 * **台账不阻挡删除**：`ingredient_edits` 指 `ingredients` 是 `ON DELETE CASCADE`（ADR-0012 修订注）
 * ——「改过」是来路不是用途。所以 #35 改过的条目也能在 `afterEach` 里删干净，不收尾不遗留。
 * 两个 project（phone / tablet）跑同一份库，所以条目名**带 project 后缀**（否则 tablet 再建同名会撞 409）。
 */

/** 本文件新建的食材规范名（带票号）+ 一个只用于搜索验证的别名 */
const NEW_NAME = '34-莴笋';
const NEW_ALIAS = '34-青笋';

/** #35 改食材用例的条目名：带 project 后缀，避免 phone / tablet 两个 project 撞名字（见文件头） */
function editName(): string {
  return `35-莴笋-${test.info().project.name}`;
}

/** 打开设置面板并进食材字典 */
async function openDictionary(page: Page): Promise<void> {
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-ingredients-entry').click();
  await expect(page.getByTestId('ingredient-dictionary-view')).toBeVisible({ timeout: 15_000 });
}

/** 从 API 找本文件新建的那条（按规范名，不写死 id——id 是服务端生成的） */
async function findIngredientByName(
  page: Page,
  name: string,
): Promise<{ id: string; name: string; aliases: string[] } | undefined> {
  const response = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent(name)}`);
  const { ingredients } = (await response.json()) as {
    ingredients: { id: string; name: string; aliases: string[] }[];
  };
  return ingredients.find((ingredient) => ingredient.name === name);
}

async function findNewIngredient(page: Page): Promise<{ id: string; name: string; aliases: string[] } | undefined> {
  return findIngredientByName(page, NEW_NAME);
}

test.afterEach(async ({ page }) => {
  // 收尾：**用自己的删除功能清场**（不直接 SQL）。都是零引用，删得掉；
  // #35 改过的条目也一样——台账是 ON DELETE CASCADE，不阻挡删除（ADR-0012 修订注）。
  const response = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent('35-')}`);
  const { ingredients } = (await response.json()) as { ingredients: { id: string; name: string }[] };
  for (const ingredient of ingredients.filter((item) => item.name.startsWith('35-'))) {
    await page.request.delete(`${ROOT_URL}/api/ingredients/${ingredient.id}`);
  }
  const existing = await findNewIngredient(page);
  if (existing) {
    await page.request.delete(`${ROOT_URL}/api/ingredients/${existing.id}`);
  }
});

/**
 * 第一条：**入口路径**连壳的形态。
 *
 * 从设置钻进来 → 底部/侧边导航消失、顶部有「← 设置」→ 点它回到首页并自动摆开设置面板。
 * 这条在手机与平板两个 project 下都跑（`tablet` 已按视口自动分流）。
 */
test('设置 → 食材字典 → 「← 设置」返回，整条路径通', async ({ page }) => {
  await openDictionary(page);

  // 从属页面的壳：主导航消失（两种版式下都不显示）、顶部有「← 设置」
  await expect(page.getByTestId('main-nav')).toHaveCount(0);
  await expect(page.getByTestId('ingredient-back-settings')).toBeVisible();
  await expect(page.getByTestId('ingredient-back-settings')).toContainText('设置');

  // 字典本身在：搜索框 + 计数 + 录入入口
  await expect(page.getByTestId('ingredient-search-input')).toBeVisible();
  await expect(page.getByTestId('ingredient-create-open')).toBeVisible();
  await expect(page.getByTestId('ingredient-count')).toBeVisible();

  // 返回设置：回到首页并自动摆开设置面板（hash 那条路，与菜谱库同一形态）
  await page.getByTestId('ingredient-back-settings').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('settings-ingredients-entry')).toBeVisible();
});

/**
 * 第二条：**搜索「西红柿」命中规范名「番茄」**（别名匹配）。
 * 这是「家人用什么叫法我都能找到」的判据，也是列表接口与前端过滤同一口径的活路径。
 */
test('搜索能命中别名：搜「西红柿」出来「番茄」', async ({ page }) => {
  await openDictionary(page);

  await page.getByTestId('ingredient-search-input').fill('西红柿');
  await expect(page.getByTestId('ingredient-row-tomato')).toBeVisible();
  await expect(page.getByTestId('ingredient-name-tomato')).toHaveText('番茄');

  // 无关词搜不到，且给出「新建这个」的入口（不是死路）
  await page.getByTestId('ingredient-search-input').fill('34-字典里肯定没有这个');
  await expect(page.getByTestId('ingredient-empty')).toBeVisible();
  await expect(page.getByTestId('ingredient-create-for-query')).toBeVisible();
  await expect(page.getByTestId('ingredient-create-for-query')).toContainText('34-字典里肯定没有这个');
});

/**
 * 第三条（跨层活路径）：**新建 → 搜索命中 → 删除**。
 *
 * 走的都是产品里的入口：点「＋ 录入一条新食材」→ 填表 → 保存 → 列表上搜到 → 进详情 →
 * 删除（零引用）。服务端那一份与界面同源：录完 API 里立刻查得到，删完 API 里立刻没了。
 */
test('新建 → 搜索命中 → 删除（用自己的删除功能清场）', async ({ page }) => {
  await openDictionary(page);

  // 录入：只填规范名 + 一个别名（其余全空 = 四季有售、无「含」指针）
  await page.getByTestId('ingredient-create-open').click();
  await expect(page.getByTestId('ingredient-editor-new')).toBeVisible();
  await page.getByTestId('ingredient-name-new').fill(NEW_NAME);
  await page.getByTestId('ingredient-aliases-new').fill(NEW_ALIAS);
  await page.getByTestId('ingredient-save-new').click();

  // 录完落在详情上；服务端那一份与界面同源
  const created = await findNewIngredient(page);
  expect(created?.name).toBe(NEW_NAME);
  expect(created?.aliases).toContain(NEW_ALIAS);
  const id = created!.id;
  await expect(page.getByTestId(`ingredient-detail-${id}`)).toBeVisible({ timeout: 15_000 });
  // 新条目没录时令 = 四季有售（不写月份行）
  await expect(page.getByTestId(`ingredient-season-${id}`)).toContainText('四季有售');

  // 回列表，搜别名也能命中它
  await page.getByTestId('ingredient-back').click();
  await page.getByTestId('ingredient-search-input').fill(NEW_ALIAS);
  await expect(page.getByTestId(`ingredient-row-${id}`)).toBeVisible();
  await expect(page.getByTestId(`ingredient-name-${id}`)).toHaveText(NEW_NAME);

  // 进详情 → 零引用 → 给删除按钮（不是说明）
  await page.getByTestId(`ingredient-row-${id}`).click();
  await expect(page.getByTestId(`ingredient-referenced-${id}`)).toHaveCount(0);
  await page.getByTestId(`ingredient-delete-${id}`).click();
  await page.getByTestId(`ingredient-delete-confirm-${id}`).click();

  // 真的从列表接口消失（删除功能自己的清场路径）
  await expect.poll(async () => (await findNewIngredient(page))?.id, { timeout: 15_000 }).toBeUndefined();
});

/**
 * 第四条：**有引用的食材给说明而不是按钮**（issue AC）。
 *
 * 拿种子里的「番茄」（被种子菜谱引用）验：详情里不该有删除按钮，而该有那句「还有地方在用它」。
 * 与菜谱编辑器对退役/草稿「把下一步说出来」的既有口径一致。
 */
test('有引用时给说明而不是一个按下去必报错的按钮', async ({ page }) => {
  await openDictionary(page);

  await page.getByTestId('ingredient-search-input').fill('番茄');
  await page.getByTestId('ingredient-row-tomato').click();

  await expect(page.getByTestId('ingredient-referenced-tomato')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ingredient-referenced-tomato')).toContainText('不能删');
  await expect(page.getByTestId('ingredient-delete-tomato')).toHaveCount(0);
});

/**
 * 第五条：**「名字（名字）」不再出现**（既有渲染毛病的回归网）。
 *
 * 种子里黄芪挂着与规范名同名的别名（迁移 005）。字典页要渲染别名列表，正是第一个会撞上它的地方——
 * 别名列表里不该重复出现规范名。画像页那处同类显示由 `ingredientVocabulary.ts` 的同一判据覆盖。
 */
test('与规范名同名的别名只显示一次（不再出现「黄芪（黄芪）」）', async ({ page }) => {
  await openDictionary(page);

  await page.getByTestId('ingredient-search-input').fill('黄芪');
  await page.getByTestId('ingredient-row-astragalus').click();

  const detail = page.getByTestId('ingredient-detail-astragalus');
  await expect(detail).toBeVisible();
  // 别名列表里只有规范名一次：同名的别名被滤掉了
  await expect(page.getByTestId('ingredient-aliases-astragalus')).toContainText('还没有别名');
  await expect(detail).not.toContainText('黄芪（黄芪）');
});

/**
 * 第六条：手指宽的验收（总纲「手机优先」）——字典页与录入表单不吃手机宽度。
 */
test('食材字典与录入表单不横向溢出（对当前视口宽度断言）', async ({ page }) => {
  await openDictionary(page);
  const listWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(listWidth).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByTestId('ingredient-create-open').click();
  await expect(page.getByTestId('ingredient-editor-new')).toBeVisible();
  const editorWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(editorWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});

/**
 * 第七条（#35 跨层活路径）：**改食材 → 改名跟着换说法 → 台账看得见**。
 *
 * 走产品里的入口：录入 → 进详情 → 「改这条食材」→ 改规范名 + 补别名 → 保存。
 * 服务端那一份与界面同源：列表里读新名、引用它的菜谱详情也读新名（无名称快照），
 * 详情卡上的「改动台账」列出这一次改了什么、谁改的。
 */
test('改食材：改名后列表与台账都跟着换说法，且留了痕', async ({ page }) => {
  await openDictionary(page);

  const name = editName();
  // 改名后的名字与别名都**不包含**旧名：搜索是子串匹配，若新名含旧名，搜旧名会照旧命（那是搜索的行为，不是改名的）
  const renamed = `35-生菜-${test.info().project.name}`;
  const alias = `35-鹅仔菜-${test.info().project.name}`;

  // 录入一条（只填规范名）作为待改的对象
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(name);
  await page.getByTestId('ingredient-save-new').click();

  const created = await findIngredientByName(page, name);
  expect(created?.name).toBe(name);
  const id = created!.id;
  await expect(page.getByTestId(`ingredient-detail-${id}`)).toBeVisible({ timeout: 15_000 });

  // 改：规范名 + 别名（走界面）
  await page.getByTestId(`ingredient-edit-open-${id}`).click();
  await expect(page.getByTestId(`ingredient-editor-${id}`)).toBeVisible();
  await page.getByTestId(`ingredient-name-edit-${id}`).fill(renamed);
  await page.getByTestId(`ingredient-aliases-edit-${id}`).fill(alias);
  await page.getByTestId(`ingredient-save-edit-${id}`).click();

  // 保存回到只读态：详情与列表都读新名
  await expect(page.getByTestId(`ingredient-detail-${id}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`ingredient-detail-name-${id}`)).toHaveText(renamed);
  await expect.poll(async () => (await findIngredientByName(page, renamed))?.aliases, { timeout: 15_000 }).toContain(alias);

  // 台账看得见（谁、改了哪几块）：名字与别名两块都在
  const history = page.getByTestId(`ingredient-history-${id}`);
  await expect(history.getByTestId(`ingredient-history-item-${id}-0`)).toContainText('规范名');
  await expect(history.getByTestId(`ingredient-history-item-${id}-0`)).toContainText('别名');

  // 回列表搜旧名搜不到、搜新名搜得到（改名之后全跟着换说法）
  await page.getByTestId('ingredient-back').click();
  await page.getByTestId('ingredient-search-input').fill(name);
  await expect(page.getByTestId(`ingredient-row-${id}`)).toHaveCount(0);
  await page.getByTestId('ingredient-search-input').fill(renamed);
  await expect(page.getByTestId(`ingredient-row-${id}`)).toBeVisible();
});

/**
 * 第八条（#35）：**四个字段一个都没变 → 明确报「没有任何改动」**（不假装成功）。
 *
 * 点开「改这条食材」什么都不改就保存——这条用例正是要确认那句提示真的会出现，
 * 而且**不写台账**（点开看了看又保存不留空记录）。
 */
test('改食材：什么都没改就保存，明确提示「没有任何改动」', async ({ page }) => {
  await openDictionary(page);

  const name = `${editName()}-无改动`;
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(name);
  await page.getByTestId('ingredient-save-new').click();
  const created = await findIngredientByName(page, name);
  const id = created!.id;
  await expect(page.getByTestId(`ingredient-detail-${id}`)).toBeVisible({ timeout: 15_000 });

  // 打开编辑器、什么都不改、直接保存
  await page.getByTestId(`ingredient-edit-open-${id}`).click();
  await page.getByTestId(`ingredient-save-edit-${id}`).click();

  // 明确的提示（服务端 409 no_changes 翻成的那句话）
  await expect(page.getByTestId(`ingredient-error-edit-${id}`)).toContainText('没有任何改动', { timeout: 15_000 });

  // 台账仍是空的（没写空记录），取消后详情上的「改动台账」说还没改过
  await page.getByTestId(`ingredient-edit-cancel-${id}`).click();
  await expect(page.getByTestId(`ingredient-history-${id}`)).toContainText('还没有改过');
});
