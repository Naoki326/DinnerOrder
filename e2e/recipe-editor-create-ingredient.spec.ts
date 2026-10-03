import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 菜谱编辑器里**搜不到食材就地新建**（issue #36；ADR-0012「决定一」）。
 *
 * 这个文件只验**单测验不了的跨层活路径**（issue 的 Testing Decisions 点名）：
 *   搜不到 → 就地新建 → 直接进食材行 → 填克数 → 保存，并断言**草稿一路没丢**。
 * 新建的食材真的落进字典、又被这道菜真实引用（保存后菜谱的食材清单里有它）——这是
 * 「两处入口各自渲染表单」与「受控字典」两条口径合起来才对得上的活路径。
 *
 * ## 收尾纪律（E2E 共用一个库）
 *
 * 菜谱**没有物理删路由**（只有退役），所以本文件新建的那道菜收尾只能**退役**
 * （退役菜不进推荐池、不上加菜器）。但它引用的那条新食材可以清干净：先把食材从菜谱清单里
 * PATCH 掉（它变成零引用），再 `DELETE /api/ingredients/:id`——字典是更敏感的那份共享资源。
 * 那道退役菜留下的痕迹在报告里说明。
 *
 * 名字一律带票号 `36-` + **唯一后缀**（时间戳）：`recipes.name` 与 `ingredients.name` 都是
 * UNIQUE，固定名字会让重跑撞 409；`36-` 前缀让库里的痕迹自报家门（与 #34/#35 的 `34-`/`35-` 同形）。
 */

const PREFIX = '36-';

/** 每次运行唯一：避免 `recipes.name` / `ingredients.name` 的 UNIQUE 让重跑撞车 */
function uniqueSuffix(): string {
  return `${test.info().project.name}-${Date.now()}`;
}

interface RecipeJson {
  id: string;
  name: string;
  status: string;
  steps: string;
  ingredients: { ingredientId: string; name: string; adultGrams: number }[];
}

async function findRecipeByName(page: Page, name: string): Promise<RecipeJson | undefined> {
  const response = await page.request.get(`${ROOT_URL}/api/recipes?status=all`);
  const { recipes } = (await response.json()) as { recipes: RecipeJson[] };
  return recipes.find((recipe) => recipe.name === name);
}

async function findIngredientByName(
  page: Page,
  name: string,
): Promise<{ id: string; name: string; aliases: string[] } | undefined> {
  const response = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent(name)}`);
  const { ingredients } = (await response.json()) as { ingredients: { id: string; name: string; aliases: string[] }[] };
  return ingredients.find((ingredient) => ingredient.name === name);
}

/** 打开设置面板并进菜谱库（与 `recipe-library.spec.ts` 同一入口路径） */
async function openLibrary(page: Page): Promise<void> {
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-recipes-entry').click();
  await expect(page.getByTestId('recipe-library-view')).toBeVisible({ timeout: 15_000 });
}

/** 收尾：把本次造的菜谱退役、把它引用的新食材清干净（字典是更敏感的共享资源） */
test.afterEach(async ({ page }) => {
  const response = await page.request.get(`${ROOT_URL}/api/recipes?status=all`);
  const { recipes } = (await response.json()) as { recipes: RecipeJson[] };
  for (const recipe of recipes.filter((item) => item.name.startsWith(PREFIX))) {
    // 退役菜不能再 PATCH（领域层：退役的先还原），所以先摘食材、再退役。
    // 摘掉食材让那条新食材变成零引用，DELETE 才删得掉——这步只为清理，不是产品行为。
    if (recipe.status !== 'retired') {
      await page.request.patch(`${ROOT_URL}/api/recipes/${recipe.id}`, { data: { ingredients: [] } });
      await page.request.post(`${ROOT_URL}/api/recipes/${recipe.id}/retire`, { data: { memberId: 'mom' } });
    }
  }
  // 本文件造的食材（零引用，删得掉）——先查后删，失败不阻塞退役
  const ingredients = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent(PREFIX)}`);
  const { ingredients: list } = (await ingredients.json()) as { ingredients: { id: string; name: string }[] };
  for (const ingredient of list.filter((item) => item.name.startsWith(PREFIX))) {
    await page.request.delete(`${ROOT_URL}/api/ingredients/${ingredient.id}`);
  }
});

/**
 * 第一条（本工单的主验收面）：**搜不到 → 就地新建 → 填克数 → 保存**。
 *
 * 判别性全在「不离开草稿」上：先填菜名、做法、加一项别的食材（黄瓜），再搜一个字典没有的名字——
 * 新建动作若把组件卸载/导航走，上面这些未保存内容就会消失，断言会立刻红。
 * 新建成功后新食材直接进食材行，克数留空 + 标红 + 保存校验照旧生效。
 */
test('菜谱编辑器搜不到食材 → 就地新建 → 进食材行 → 填克数 → 保存（草稿未丢）', async ({ page }) => {
  const suffix = uniqueSuffix();
  const recipeName = `${PREFIX}就地新建-${suffix}`;
  const newIngredient = `${PREFIX}莴笋-${suffix}`;
  const steps = '草稿步骤：削皮切滚刀，热锅快炒。';

  await openLibrary(page);
  await page.getByTestId('recipe-create-open').click();
  await expect(page.getByTestId('recipe-editor-new')).toBeVisible();

  // 先填一半草稿：菜名 + 做法 + 一项别的食材（后面用它验「其他食材不能丢」）
  await page.getByTestId('recipe-name-new').fill(recipeName);
  await page.getByTestId('recipe-steps-new').fill(steps);
  await page.getByTestId('recipe-ingredient-search').fill('黄瓜');
  await page.getByTestId('recipe-add-cucumber').click();
  await page.getByTestId('recipe-grams-new-0').fill('120');

  // 搜一个字典没有的食材：不是死路，入口带**当前输入**
  await page.getByTestId('recipe-ingredient-search').fill(newIngredient);
  await expect(page.getByTestId('recipe-ingredient-not-found')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('recipe-ingredient-not-found')).toContainText('字典里没有对得上的食材');
  const createOpen = page.getByTestId('recipe-ingredient-create-open');
  await expect(createOpen).toBeVisible();
  await expect(createOpen).toContainText(newIngredient);

  // 就地展开录入表单：规范名**预填当前输入**（不用重敲）
  await createOpen.click();
  await expect(page.getByTestId('recipe-new-ingredient-form')).toBeVisible();
  await expect(page.getByTestId('recipe-new-ingredient-name')).toHaveValue(newIngredient);

  // 填个规范名就建好（其余字段都不填）
  await page.getByTestId('recipe-new-ingredient-save').click();

  // 新建成功：食材直接进食材行（第 2 项），克数留空 + 标红 + 不给保存
  await expect(page.getByTestId('recipe-ingredients-new')).toContainText(newIngredient, { timeout: 15_000 });
  await expect(page.getByTestId('recipe-grams-new-1')).toHaveValue('');
  await expect(page.getByTestId('recipe-grams-new-1')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('recipe-grams-error-new')).toBeVisible();
  await expect(page.getByTestId('recipe-save-new')).toBeDisabled();

  // **草稿一路没丢**：菜名、做法、其他食材（黄瓜）都还在，原样
  await expect(page.getByTestId('recipe-name-new')).toHaveValue(recipeName);
  await expect(page.getByTestId('recipe-steps-new')).toHaveValue(steps);
  await expect(page.getByTestId('recipe-grams-new-0')).toHaveValue('120');
  await expect(page.getByTestId('recipe-ingredients-new')).toContainText('黄瓜');

  // 新食材真的落进字典（不是只进草稿）
  const created = await findIngredientByName(page, newIngredient);
  expect(created?.name).toBe(newIngredient);

  // 填克数 → 保存校验放行 → 保存。
  // 录入成功后页面会切到刚建的这道菜（`RecipeLibraryView` 的 `onCreated` 回到列表并打开它），
  // 所以断言落在「服务端那份」与「切换后仍看得见这道菜」上，而不是 `new` 表单上的「已保存」。
  await page.getByTestId('recipe-grams-new-1').fill('150');
  await expect(page.getByTestId('recipe-grams-error-new')).toBeHidden();
  await expect(page.getByTestId('recipe-save-new')).toBeEnabled();
  await page.getByTestId('recipe-save-new').click();

  // 跨层断言：保存后这道菜的食材清单里**真的有**新建的那条（被菜谱真实引用）。
  // 点保存后服务端写入与页面跳转是异步的，所以轮询到它落库为止（不给假绿也不给假红）。
  await expect
    .poll(async () => (await findRecipeByName(page, recipeName))?.status, { timeout: 15_000 })
    .toBe('active');
  const recipe = (await findRecipeByName(page, recipeName))!;
  const names = recipe.ingredients.map((item) => item.name);
  expect(names).toContain(newIngredient);
  expect(names).toContain('黄瓜');
  // 新食材那一项的克数就是刚填的
  expect(recipe.ingredients.find((item) => item.name === newIngredient)?.adultGrams).toBe(150);

  // 录入成功后停在刚建好的这道菜的编辑页（带 id 的那份表单）
  await expect(page.getByTestId(`recipe-form-${recipe.id}`)).toBeVisible({ timeout: 15_000 });
});

/**
 * 第二条：**撞名（别名）→ 展示已有条目 + 「用它」→ 走同一条加食材回调**（不建重复的）。
 *
 * 拿种子里的「番茄」验别名冲突：`西红柿` 是它的别名。搜一个不存在的词进新建表单，
 * 把规范名改成 `西红柿` 提交 → 服务端 409 `ingredient_conflict`，界面把「番茄」摆出来。
 * 点「用它」后番茄进食材行——用的正是新建成功走的那条 `onAdd`（同一个入口，不是第二套）。
 *
 * 这条**不保存**（不发 `POST /recipes`），所以不留任何东西在库里。
 */
test('撞名（别名）→ 展示已有条目并提供「用它」，走同一条加食材回调', async ({ page }) => {
  const notInDictionary = `${PREFIX}字典里肯定没有这个`;

  await openLibrary(page);
  await page.getByTestId('recipe-create-open').click();
  await expect(page.getByTestId('recipe-editor-new')).toBeVisible();

  // 搜不到 → 进新建表单（规范名预填搜索词）
  await page.getByTestId('recipe-ingredient-search').fill(notInDictionary);
  await expect(page.getByTestId('recipe-ingredient-create-open')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('recipe-ingredient-create-open').click();
  await expect(page.getByTestId('recipe-new-ingredient-name')).toHaveValue(notInDictionary);

  // 改成一条**已有别名**提交：409 → 把已有条目（番茄）摆出来
  await page.getByTestId('recipe-new-ingredient-name').fill('西红柿');
  await page.getByTestId('recipe-new-ingredient-save').click();
  await expect(page.getByTestId('recipe-new-ingredient-conflict')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('recipe-new-ingredient-conflict')).toContainText('番茄');
  await expect(page.getByTestId('recipe-new-ingredient-conflict')).toContainText('已经在字典里');

  // 「用它」→ 走同一条 onAdd：番茄进食材行（第 0 项），克数留空
  await page.getByTestId('recipe-new-ingredient-use').click();
  await expect(page.getByTestId('recipe-new-ingredient-form')).toHaveCount(0);
  await expect(page.getByTestId('recipe-ingredients-new')).toContainText('番茄', { timeout: 15_000 });
  await expect(page.getByTestId('recipe-grams-new-0')).toHaveValue('');

  // 没有建出重复的那条（`36-` 前缀一条都不该有）
  const response = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent(PREFIX)}`);
  const { ingredients } = (await response.json()) as { ingredients: { name: string }[] };
  expect(ingredients.filter((item) => item.name.startsWith(PREFIX))).toHaveLength(0);
});

/**
 * 第三条：**撞名（规范名）→ 同样是展示已有条目 + 「用它」**（AC 写的是「规范名**或**别名」）。
 *
 * 上一条走的是别名那一路（服务端 `field: 'alias'`）；这一条走**规范名**那一路
 * （服务端 `field: 'name'`）。前端不按 `field` 分支、只认 `err.conflict`，所以两条应该走同一个入口——
 * 这条用例正是要钉住这一点：改名撞名后照样给出「用它」，点下去番茄进食材行。
 *
 * 同样**不保存**，不留痕迹。
 */
test('撞名（规范名）→ 也展示已有条目并提供「用它」', async ({ page }) => {
  const notInDictionary = `${PREFIX}字典里也肯定没有这个`;

  await openLibrary(page);
  await page.getByTestId('recipe-create-open').click();
  await expect(page.getByTestId('recipe-editor-new')).toBeVisible();

  await page.getByTestId('recipe-ingredient-search').fill(notInDictionary);
  await expect(page.getByTestId('recipe-ingredient-create-open')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('recipe-ingredient-create-open').click();

  // 填一条**已有的规范名**（番茄自己的名字，不是它的别名）：服务端回 field: 'name' 的 409
  await page.getByTestId('recipe-new-ingredient-name').fill('番茄');
  await page.getByTestId('recipe-new-ingredient-save').click();
  await expect(page.getByTestId('recipe-new-ingredient-conflict')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('recipe-new-ingredient-conflict')).toContainText('番茄');

  // 「用它」走同一条 onAdd，且没建出重复条目
  await page.getByTestId('recipe-new-ingredient-use').click();
  await expect(page.getByTestId('recipe-ingredients-new')).toContainText('番茄', { timeout: 15_000 });

  const response = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent('番茄')}`);
  const { ingredients } = (await response.json()) as { ingredients: { name: string }[] };
  expect(ingredients.filter((item) => item.name === '番茄')).toHaveLength(1);
  // 也没误建出带前缀的重复项（与第二条同一道网）
  const prefixed = await page.request.get(`${ROOT_URL}/api/ingredients?q=${encodeURIComponent(PREFIX)}`);
  const { ingredients: all } = (await prefixed.json()) as { ingredients: { name: string }[] };
  expect(all.filter((item) => item.name.startsWith(PREFIX))).toHaveLength(0);
});
