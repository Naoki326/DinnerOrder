import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 菜谱库：掌勺者可写（issue #30；ADR-0009）。
 *
 * 这个文件只验**单测验不了的两件事**（issue 的 Testing Decisions 点名）：
 *   1. **入口路径本身**：设置 → 菜谱库 → 编辑 → 保存，含 `hideTabBar` 壳的形态与「← 设置」返回。
 *   2. **`RecipeRetiredError` 那条跨模块活路径**：`domain/slots.ts` 的「退役菜不能进菜单」
 *      在非测试路径里此前**永远不会触发**（没有任何代码写出 `retired`）。做完退役按钮后它是活路径，
 *      且它跨「菜谱写路径」与 slots 领域——单测各验一半会得到两条都过、合起来错的假绿。
 *
 * ## 收尾纪律（E2E 共用一个库）
 *
 * 本 spec 按字母序排在 `promote` 与 `recommend` 之间，**后面还有 `recommend` / `replace` / `review`
 * 三份 spec 依赖种子池**。所以本文件只碰**自己新建的那道菜**，一条种子菜都不动：
 *   * 新建的菜最后**退役**（退役菜不进推荐、不上加菜器）——给后续 spec 留下的痕迹最小；
 *   * 「退役菜不能进菜单」那条用例也拿新建的菜验（不拿种子菜，避免留下一个退役的荤位把
 *     后续推荐的池子打薄）。
 */

/** 本文件新建的那道菜（名字带票号，出问题时库里的痕迹自报家门） */
const NEW_NAME = '#30 手写测试菜（可退役）';

async function clearDecidedSlots(page: Page, days = 14): Promise<void> {
  const response = await page.request.get(`${ROOT_URL}/api/slots?days=${days}`);
  const { slots } = (await response.json()) as { slots: { id: string; status: string }[] };
  for (const slot of slots.filter((item) => item.status === 'decided')) {
    await page.request.delete(`${ROOT_URL}/api/slots/${slot.id}`);
  }
}

/** 从 API 找本文件新建的那道菜（按名字，不写死 id——id 是服务端生成的） */
async function findNewRecipe(
  page: Page,
): Promise<{ id: string; status: string; steps: string; kind: string; source: string } | undefined> {
  const response = await page.request.get(`${ROOT_URL}/api/recipes?status=all`);
  const { recipes } = (await response.json()) as {
    recipes: { id: string; name: string; status: string; steps: string; kind: string; source: string }[];
  };
  return recipes.find((recipe) => recipe.name === NEW_NAME);
}

/** 打开设置面板并进菜谱库 */
async function openLibrary(page: Page): Promise<void> {
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-recipes-entry').click();
  await expect(page.getByTestId('recipe-library-view')).toBeVisible({ timeout: 15_000 });
}

test.afterEach(async ({ page }) => {
  await clearDecidedSlots(page);
});

/**
 * 第一条：**录入 → 改 → 保存**这条界面路真的通，且从属页面的壳是对的。
 *
 * 用一道新菜（不动种子）：从设置钻进来 → 录进库 → 列表上看得见 → 改做法 → 保存 → 读回来对得上。
 */
test('设置 → 菜谱库 → 录入一道新菜 → 改做法 → 保存（入口路径）', async ({ page }) => {
  await openLibrary(page);

  // 从属页面的壳：底部导航消失、顶部有「← 设置」
  await expect(page.getByTestId('main-nav')).toHaveCount(0);
  await expect(page.getByTestId('recipe-back-settings')).toBeVisible();
  await expect(page.getByTestId('recipe-back-settings')).toContainText('设置');

  // 三档 tab 都在，家庭菜档是缺省
  await expect(page.getByTestId('recipe-tab-family')).toBeVisible();
  await expect(page.getByTestId('recipe-tab-external')).toBeVisible();
  await expect(page.getByTestId('recipe-tab-retired')).toBeVisible();

  // 录一道新菜：**走界面**（点「＋ 录入一道新菜」→ 填表单 → 提交）——这是 ADR-0009 的主干动作
  await page.getByTestId('recipe-create-open').click();
  await expect(page.getByTestId('recipe-editor-new')).toBeVisible();
  await page.getByTestId('recipe-name-new').fill(NEW_NAME);
  await page.getByTestId('recipe-kind-new').selectOption('veg');
  await page.getByTestId('recipe-steps-new').fill('初始做法：切好，下锅，炒熟。');
  // 加一项食材（搜字典 → 点中）
  await page.getByTestId('recipe-ingredient-search').fill('黄瓜');
  await page.getByTestId('recipe-add-cucumber').click();
  await page.getByTestId('recipe-grams-new-0').fill('120');
  await page.getByTestId('recipe-save-new').click();

  // 录完直接进详情（家庭菜档）——状态就是「已进库」
  const created = await findNewRecipe(page);
  expect(created?.status).toBe('active');
  const recipe = created!;
  expect(recipe.source).toBe('oral');
  await expect(page.getByTestId(`recipe-form-${recipe.id}`)).toBeVisible();
  await expect(page.getByTestId(`recipe-steps-${recipe.id}`)).toHaveValue('初始做法：切好，下锅，炒熟。');
  await expect(page.getByTestId(`recipe-grams-${recipe.id}-0`)).toHaveValue('120');

  // 改做法 + 改克数，保存
  await page.getByTestId(`recipe-steps-${recipe.id}`).fill('家里的做法：多加一步，先焯水。');
  await page.getByTestId(`recipe-grams-${recipe.id}-0`).fill('180');
  await page.getByTestId(`recipe-save-${recipe.id}`).click();
  await expect(page.getByTestId(`recipe-saved-${recipe.id}`)).toBeVisible({ timeout: 15_000 });

  // 服务端那一份与界面同源：内容变了，身份没变
  const after = await findNewRecipe(page);
  expect(after?.steps).toContain('先焯水');
  expect(after?.status).toBe('active');

  // 修改历史里看得见这一次改动（谁、改了哪几块）
  const history = page.getByTestId(`recipe-history-${recipe.id}`);
  await expect(history.getByTestId(`recipe-history-item-${recipe.id}-0`)).toContainText('做法');
  await expect(history.getByTestId(`recipe-history-item-${recipe.id}-0`)).toContainText('妈妈');

  // 「← 菜谱库」回列表；再从列表回设置
  await page.getByTestId('recipe-back').click();
  await expect(page.getByTestId('recipe-library-view')).toBeVisible();
});

/**
 * 第二条：**谁都能写**（需求变更 2026-09-27，原 spec 的「只有掌勺者可写」已撤）。
 *
 * 判别性：切成**大宝**（不是掌勺者，`is_cook=0`）后，编辑表单**照样在**、也能真存下去。
 * 与 **转正入口**有意不同：那个看「这一餐的掌勺者」（`ReviewView`，spec 明确要求，保持不变）；
 * 菜谱库不属于任何一餐，没有「那一餐的掌勺者」可用。把掌勺者限制加回来的实现会把这条打红。
 */
test('菜谱库谁都能写：切成大宝（不是掌勺者）照样能编辑并保存', async ({ page }) => {
  await clearDecidedSlots(page);
  await openLibrary(page);

  // 切成大宝：不是掌勺者（种子 is_cook 是妈妈）
  await page.getByTestId('identity-chip').click();
  await page.getByTestId('identity-option-dabao').click();
  await expect(page.getByTestId('identity-name')).toHaveText('大宝');

  // 录入入口在（不是掌勺者也看得到）
  await expect(page.getByTestId('recipe-create-open')).toBeVisible();

  // 打开一道家庭菜：编辑表单在（不是「只给掌勺者」的说明）
  await page.getByTestId('recipe-search-input').fill('番茄炒蛋');
  await page.getByTestId('recipe-row-fanqiechaodan').click();
  await expect(page.getByTestId('recipe-form-fanqiechaodan')).toBeVisible();
  await expect(page.getByTestId('recipe-cook-only')).toBeHidden();

  // 真存得下去（不是只给看）——台账里记的是大宝
  const before = await page.request.get(`${ROOT_URL}/api/recipes/fanqiechaodan`);
  const originalSteps = ((await before.json()) as { recipe: { steps: string } }).recipe.steps;
  await page.getByTestId('recipe-steps-fanqiechaodan').fill('大宝改的做法：多放点糖。');
  await page.getByTestId('recipe-save-fanqiechaodan').click();
  await expect(page.getByTestId('recipe-saved-fanqiechaodan')).toBeVisible({ timeout: 15_000 });
  const after = await page.request.get(`${ROOT_URL}/api/recipes/fanqiechaodan`);
  expect(((await after.json()) as { recipe: { steps: string } }).recipe.steps).toContain('大宝改的做法');

  // 还原做法（后续 spec 靠种子态），并复原身份成妈妈
  await page.request.patch(`${ROOT_URL}/api/recipes/fanqiechaodan`, {
    data: { steps: originalSteps, memberId: 'mom' },
  });
  await page.getByTestId('identity-chip').click();
  await page.getByTestId('identity-option-mom').click();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');
});

/**
 * 第三条：**0 克不给保存**（「待重标」从 LLM 的活变成掌勺者能手工补的活）。
 *
 * 拿 008 种下的待重标样本（主料排骨 0 克）验：那一项显示为空 + 不给保存；
 * 填上正数之后才存得下去，而且列表上的「有克数没定」标记随之消失。
 */
test('克数没定就不给保存；填上真数后「待重标」标记消失', async ({ page }) => {
  const PENDING = 'pending_relabel_ribs';
  await openLibrary(page);

  // 外部菜档：默认只看待处理，这道菜一定在（它有 0 克项）
  await page.getByTestId('recipe-tab-external').click();
  await page.getByTestId('recipe-search-input').fill('土豆炖排骨');
  await expect(page.getByTestId(`recipe-pending-${PENDING}`)).toContainText('有克数没定');

  await page.getByTestId(`recipe-row-${PENDING}`).click();
  await expect(page.getByTestId(`recipe-form-${PENDING}`)).toBeVisible();
  // 0 克项显示为空（不是 0）
  await expect(page.getByTestId(`recipe-grams-${PENDING}-0`)).toHaveValue('');
  await expect(page.getByTestId(`recipe-grams-error-${PENDING}`)).toBeVisible();
  await expect(page.getByTestId(`recipe-save-${PENDING}`)).toBeDisabled();

  // 填上成人份克数：保存按钮活过来
  await page.getByTestId(`recipe-grams-${PENDING}-0`).fill('150');
  await expect(page.getByTestId(`recipe-grams-error-${PENDING}`)).toBeHidden();
  await expect(page.getByTestId(`recipe-save-${PENDING}`)).toBeEnabled();
});

/**
 * 第四条（跨模块活路径）：**退役菜不能进菜单**。
 *
 * `RecipeRetiredError` 此前只在测试里到过——做完退役按钮它是活路径，且跨「菜谱写路径」与
 * slots 领域：单测各验一半会得到两条都过、合起来错的假绿，所以必须在这里验。
 *
 * 收尾：把它**还原**（用界面按钮），并复原成没退役的样子留给后续 spec。
 */
test('退役的菜不能进菜单（RecipeRetiredError 的活路径，跨菜谱与 slots）', async ({ page }) => {
  await clearDecidedSlots(page);
  const existing = await findNewRecipe(page);
  if (!existing) throw new Error('上一条用例没留下新菜？本文件必须按序跑（顺序依赖见文件头）');
  const recipeId = existing.id;

  await openLibrary(page);
  await page.getByTestId('recipe-search-input').fill(NEW_NAME);
  await page.getByTestId(`recipe-row-${recipeId}`).click();

  // 退役：状态翻到 retired，落进「已退役」档
  await page.getByTestId(`recipe-retire-${recipeId}`).click();
  await expect(page.getByTestId(`recipe-editor-${recipeId}`)).toBeVisible();
  await expect
    .poll(async () => (await findNewRecipe(page))?.status, { timeout: 15_000 })
    .toBe('retired');

  // 拿它去定餐：跨模块的活路径 —— 400 recipe_retired
  const slotResponse = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await slotResponse.json()) as { slots: { id: string; status: string }[] };
  const slotId = slots.find((slot) => slot.status === 'undecided')?.id;
  expect(slotId).toBeTruthy();

  const booked = await page.request.put(`${ROOT_URL}/api/slots/${slotId}`, {
    data: { diners: ['mom'], dishes: [{ recipeId }] },
  });
  expect(booked.status()).toBe(400);
  const body = (await booked.json()) as { error: string; recipeId?: string };
  expect(body.error).toBe('recipe_retired');
  expect(body.recipeId).toBe(recipeId);

  // 界面上也看得见「加不进来」（走加菜器这条真实路径）
  await page.goto(`${ROOT_URL}/slot/${slotId}`);
  await page.getByTestId('dish-picker-toggle').click();
  await page.getByTestId('dish-search-input').fill(NEW_NAME);
  // 退役菜不上加菜器（`sortForBooking` 挡在外面）
  await expect(page.getByTestId(`pick-${recipeId}`)).toBeHidden();

  // 收尾：还原（退役错了不是不可挽回的）——「已退役」档里有还原入口
  await openLibrary(page);
  await page.getByTestId('recipe-tab-retired').click();
  await page.getByTestId('recipe-search-input').fill(NEW_NAME);
  await page.getByTestId(`recipe-row-${recipeId}`).click();
  await page.getByTestId(`recipe-restore-${recipeId}`).click();
  await expect.poll(async () => (await findNewRecipe(page))?.status, { timeout: 15_000 }).toBe('active');
});

/**
 * 第五条：手指宽的验收（总纲「手机优先」）——菜谱库不吃手机宽度。
 */
test('菜谱库与编辑页不横向溢出（对当前视口宽度断言）', async ({ page }) => {
  await openLibrary(page);
  const listWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(listWidth).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.getByTestId('recipe-search-input').fill('番茄炒蛋');
  await page.getByTestId('recipe-row-fanqiechaodan').click();
  await expect(page.getByTestId('recipe-form-fanqiechaodan')).toBeVisible();
  const editorWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(editorWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});
