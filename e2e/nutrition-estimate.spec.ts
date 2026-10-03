import { expect, test, type Page } from '@playwright/test';
import { LLM_DOWN_URL, ROOT_URL } from './test-env';

/**
 * 估算营养（CONTEXT「估算营养」；ADR-0013；issue #38）的**跨层活路径**。
 *
 * 单测覆盖了「提议的池子、参照越界、source 自证、读数覆盖保护」（`llm/nutrition-estimate-schema.test.ts`
 * 与 `api/ingredient-nutrition.test.ts`）。这个文件只验单测验不了的三件事：
 *   1. **预填 → 人改 → 落库**：界面上点「估算营养」把四项填进输入框、改一个数、保存，
 *      库里那行真的是**人改过的那份**、`source` 自证是估算（`ingredient-nutrition-suggestion-*`
 *      与 `ingredient-nutrition-value-*` 的读数对得上）。
 *   2. **AI 不可用不拦保存**：LLM 故障实例（8792）上四项留空、界面只说一句「AI 暂时用不了」、
 *      **保存照旧成功**（缺营养是既有的合法状态）。
 *   3. **两种空是两句不同的话**：`degraded: true`（用不了）与「AI 也拿不准」（估不出来）
 *      在界面上是两句不同的文案——交叉否定。
 *
 * ## 收尾纪律（E2E 共用一个库）
 *
 * 本 spec 按字母序排在 `meal` **之前**、`recommend` / `replace` / `review` 三份依赖种子池的
 * spec **之前**。所以它只碰**自己新建的条目**（名字带 `38-`），并在 `afterEach` 里
 * **用自己的删除功能**清场（都是零引用，删得掉；营养行随食材 CASCADE 走）。
 *
 * 两个 project（phone / tablet）跑同一份库，所以条目名**带 project 后缀**（否则 tablet 再建同名会撞 409）。
 */

function uniqueName(prefix: string): string {
  return `38-${prefix}-${test.info().project.name}`;
}
/** 打开设置面板并进食材字典 */
async function openDictionary(page: Page): Promise<void> {
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-ingredients-entry').click();
  await expect(page.getByTestId('ingredient-dictionary-view')).toBeVisible({ timeout: 15_000 });
}

/** 同上，但打开 **LLM 故障实例**（`E2E_LLM_MODE=fail`，端口 8792）的字典页 */
async function openDictionaryOnLlmDown(page: Page): Promise<void> {
  await page.goto(`${LLM_DOWN_URL}/`);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-sheet')).toBeVisible();
  await page.getByTestId('settings-ingredients-entry').click();
  await expect(page.getByTestId('ingredient-dictionary-view')).toBeVisible({ timeout: 15_000 });
}

/** 从 API 读一条食材（含营养行） */
async function findIngredient(
  page: Page,
  name: string,
  base = ROOT_URL,
): Promise<
  | {
      id: string;
      name: string;
      nutrition: { energyKcal: number; proteinG: number; fatG: number; carbG: number; source: string; estimated: boolean } | null;
    }
  | undefined
> {
  const response = await page.request.get(`${base}/api/ingredients?q=${encodeURIComponent(name)}`);
  const { ingredients } = (await response.json()) as {
    ingredients: {
      id: string;
      name: string;
      nutrition: { energyKcal: number; proteinG: number; fatG: number; carbG: number; source: string; estimated: boolean } | null;
    }[];
  };
  return ingredients.find((ingredient) => ingredient.name === name);
}

/** 清场：把本 spec 新建的条目（名字带 `38-`）用自己的删除功能删掉（营养行随 CASCADE 走） */
test.afterEach(async ({ page }) => {
  for (const base of [ROOT_URL, LLM_DOWN_URL]) {
    const response = await page.request.get(`${base}/api/ingredients?q=${encodeURIComponent('38-')}`);
    const { ingredients } = (await response.json()) as { ingredients: { id: string; name: string }[] };
    for (const ingredient of ingredients.filter((item) => item.name.startsWith('38-'))) {
      await page.request.delete(`${base}/api/ingredients/${ingredient.id}`);
    }
  }
});

/**
 * 第一条（主验收面）：**估算营养 → 预填四项 → 人改一个数 → 保存 → 库里那行自证是估算**。
 *
 * 「人可改」这一半是关键：只断言「四项被填上了」抓不住「预填变成决定」那个 bug——
 * 所以这里**改一个数**再保存，然后断言落库的是**改后的值**。
 */
test('估算营养 → 预填四项 → 人改一个数 → 保存：库里那行自证是估算且带模型名', async ({ page }) => {
  await openDictionary(page);

  const name = uniqueName('蚝油');
  await page.getByTestId('ingredient-create-open').click();
  await expect(page.getByTestId('ingredient-editor-new')).toBeVisible();
  await page.getByTestId('ingredient-name-new').fill(name);

  // 点「估算营养」：**四项被预填**（AC 原文），并出现说明（参照的成分表条目 + 重新填入）
  await page.getByTestId('ingredient-nutrition-suggest-new').click();
  const estimate = page.getByTestId('ingredient-nutrition-estimate-new');
  await expect(estimate).toBeVisible({ timeout: 15_000 });
  await expect(estimate).toContainText('估算值');
  await expect(estimate).toContainText('酱油(均值)');

  // **仍未落库**：预填只是预填
  expect(await findIngredient(page, name)).toBeUndefined();

  // **预填**：不用再点一下——数字来自 fake 参照的那条真读数（酱油(均值) 64.3）
  await expect(page.getByTestId('ingredient-nutrition-new-energyKcal')).toHaveValue('64.3');
  await expect(page.getByTestId('ingredient-nutrition-new-proteinG')).toHaveValue('5.6');
  await expect(page.getByTestId('ingredient-nutrition-reference-new')).toContainText('酱油(均值)');

  // 人改一个数（掌勺者按自己的认识调一下）
  await page.getByTestId('ingredient-nutrition-new-proteinG').fill('6.5');

  await page.getByTestId('ingredient-save-new').click();

  // 落库：四项是**人改过的那份**，source 自证是估算（含模型标识），estimated 标记为真
  await expect.poll(async () => (await findIngredient(page, name))?.name, { timeout: 15_000 }).toBe(name);
  const stored = (await findIngredient(page, name))!;
  expect(stored.nutrition).not.toBeNull();
  expect(stored.nutrition!.proteinG).toBe(6.5);
  expect(stored.nutrition!.energyKcal).toBe(64.3);
  expect(stored.nutrition!.estimated).toBe(true);
  expect(stored.nutrition!.source).toContain('LLM 估算');
  expect(stored.nutrition!.source).toContain('酱油(均值)');
  // 与成分表读数靠 source 区分（012 那批行的出处里有平台名，估算行没有）
  expect(stored.nutrition!.source).not.toContain('食物营养成分查询平台');

  // 详情卡上也说得出来：估算值（不是「成分表读数」）
  await expect(page.getByTestId(`ingredient-nutrition-${stored.id}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`ingredient-nutrition-source-${stored.id}`)).toContainText('估算值');
});

/**
 * 第一条之二（回归网）：**一条已经有营养行的食材，只改别名也要存得下去**。
 *
 * 这是「改食材」与「估算营养」交界处最容易做坏的一条：编辑表单把已有行的四项**回填**进输入框，
 * 但那四项目测是「不完整」的（库里那行的出处文字不是「参照条目」的 id，回填不出 reference），
 * 于是四项看着「填了却没有出处」——若把这种状态一律当成「四项填了一半」拦下，
 * 那么**任何带营养行的食材都改不动了**（改名/别名/时令/「含」全被挡），
 * 既有成分表读数的 142 条更是「什么都不能改」。
 *
 * 判据必须是「**草稿与库里那行相比有没有真的变**」：没变就整块不提交、不报错；
 * 真改了却表达不了（只填一半、或换掉了数字却没有新出处）才当场说清。
 */
test('已有营养行的食材：只改别名照样存得下去（四项回填不该被当成「填了一半」）', async ({ page }) => {
  await openDictionary(page);

  const name = uniqueName('改别名');
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(name);
  // 用估算这条路落一行营养（本用例要的正是「已有营养行」这个前置）
  await page.getByTestId('ingredient-nutrition-suggest-new').click();
  await expect(page.getByTestId('ingredient-nutrition-estimate-new')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('ingredient-save-new').click();

  await expect.poll(async () => (await findIngredient(page, name))?.name, { timeout: 15_000 }).toBe(name);
  const created = (await findIngredient(page, name))!;
  expect(created.nutrition).not.toBeNull();
  const id = created.id;

  // 进编辑态：四项被**回填**（这是关键前置——不是空的）
  await page.getByTestId(`ingredient-detail-${id}`).waitFor({ timeout: 15_000 });
  await page.getByTestId(`ingredient-edit-open-${id}`).click();
  const editor = page.getByTestId(`ingredient-editor-${id}`);
  await expect(editor).toBeVisible();
  await expect(page.getByTestId(`ingredient-nutrition-edit-${id}-energyKcal`)).not.toHaveValue('');

  // 只改别名——**不该拦保存**，也不该报「四项要么全填」
  await page.getByTestId(`ingredient-aliases-edit-${id}`).fill('38-改别名后');
  await expect(page.getByTestId(`ingredient-nutrition-partial-edit-${id}`)).toHaveCount(0);
  await page.getByTestId(`ingredient-save-edit-${id}`).click();

  // 保存成功：别名落库、那一行营养**原样**（没被顺手清掉）
  await expect(page.getByTestId(`ingredient-error-edit-${id}`)).toHaveCount(0);
  await expect(page.getByTestId(`ingredient-detail-${id}`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await findIngredient(page, name))?.name, { timeout: 15_000 }).toBe(name);
  const after = (await findIngredient(page, name))!;
  expect(after.nutrition).not.toBeNull();
  expect(after.nutrition!.energyKcal).toBe(created.nutrition!.energyKcal);
});

/**
 * 第二条（AC：AI 不可用不拦保存）：LLM 故障实例上四项留空、界面说一句、**保存照旧成功**。
 *
 * 这是本票最容易被做坏的一条（顺手把「拿不到估算」当成保存失败）。
 */
test('AI 不可用：四项留空、界面说「AI 暂时用不了」、保存照旧成功', async ({ page }) => {
  await openDictionaryOnLlmDown(page);

  const name = uniqueName('没AI也能录');
  await page.getByTestId('ingredient-create-open').click();
  await expect(page.getByTestId('ingredient-editor-new')).toBeVisible();
  await page.getByTestId('ingredient-name-new').fill(name);

  await page.getByTestId('ingredient-nutrition-suggest-new').click();
  const degraded = page.getByTestId('ingredient-nutrition-degraded-new');
  await expect(degraded).toBeVisible({ timeout: 15_000 });
  await expect(degraded).toContainText('AI 暂时用不了');
  // 降级时**不显示**任何预填说明、也不显示「估不出来」那句（两句空是不同的两句话）
  await expect(page.getByTestId('ingredient-nutrition-estimate-new')).toHaveCount(0);
  await expect(page.getByTestId('ingredient-nutrition-none-new')).toHaveCount(0);

  // 四项留空（没有预填）——且**不拦保存**
  await expect(page.getByTestId('ingredient-nutrition-new-energyKcal')).toHaveValue('');
  await expect(page.getByTestId('ingredient-save-new')).toBeEnabled();
  await page.getByTestId('ingredient-save-new').click();

  // 保存成功、库里这条食材没有营养行（缺营养是既有的合法状态）
  await expect.poll(async () => (await findIngredient(page, name, LLM_DOWN_URL))?.name, { timeout: 15_000 }).toBe(name);
  expect((await findIngredient(page, name, LLM_DOWN_URL))!.nutrition).toBeNull();
});

/**
 * 第三条（AC：两种空是两句不同的话）：AI 看过了但估不出来 ≠ AI 用不了。
 *
 * 探针：fake 在食材名含「估不出」时回 `{"estimate":null}`（见 `llm/nutrition-estimate-schema.ts`）。
 * 断言是**交叉否定**的：含自己那句、不含对方那句。
 */
test('两种空是两句不同的话：AI 估不出来 ≠ AI 用不了', async ({ page }) => {
  await openDictionary(page);

  const name = uniqueName('估不出的东西');
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(name);
  await page.getByTestId('ingredient-nutrition-suggest-new').click();

  const none = page.getByTestId('ingredient-nutrition-none-new');
  await expect(none).toBeVisible({ timeout: 15_000 });
  await expect(none).toContainText('拿不准');
  // 这一句与降级那句**不是同一句**
  await expect(none).not.toContainText('AI 暂时用不了');
  await expect(page.getByTestId('ingredient-nutrition-degraded-new')).toHaveCount(0);
  await expect(page.getByTestId('ingredient-nutrition-estimate-new')).toHaveCount(0);

  // 估不出来也**不拦保存**（四项留空 = 暂缺）
  await expect(page.getByTestId('ingredient-save-new')).toBeEnabled();
});

/**
 * 第四条（AC：只有部分项有值时的行为要明确定义）：四项要么全填、要么全空。
 *
 * 只填一部分时界面**当场说清**为什么保存不了（不半真半假地进合计）——服务端的 400 是第二道网。
 */
test('四项要么全填、要么全空：只填一部分时当场说清', async ({ page }) => {
  await openDictionary(page);

  const name = uniqueName('只填一项');
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(name);

  // 只填能量一项
  await page.getByTestId('ingredient-nutrition-new-energyKcal').fill('100');
  const partial = page.getByTestId('ingredient-nutrition-partial-new');
  await expect(partial).toBeVisible();
  await expect(partial).toContainText('四项要么全填、要么全空');

  // 补上其余三项（没有参照条目 → 仍然拦着，并提示先点「估算营养」拿到出处）
  await page.getByTestId('ingredient-nutrition-new-proteinG').fill('1');
  await page.getByTestId('ingredient-nutrition-new-fatG').fill('1');
  await page.getByTestId('ingredient-nutrition-new-carbG').fill('1');
  await expect(partial).toContainText('估算营养');

  // 四项清空 → 回到「暂缺」，提示消失
  for (const key of ['energyKcal', 'proteinG', 'fatG', 'carbG']) {
    await page.getByTestId(`ingredient-nutrition-new-${key}`).fill('');
  }
  await expect(partial).toBeHidden();
  await expect(page.getByTestId('ingredient-save-new')).toBeEnabled();
});

/**
 * 第五条（ADR-0013 决定三的界面侧）：**已有成分表读数的食材不给估算按钮**，给说明。
 *
 * 与字典页对「有引用的食材不给删除按钮」同一口径：按下去必报错的动作不要给按钮。
 * 拿种子里的「生抽」（`light_soy`，012 有读数）验。
 */
test('已有成分表读数：给说明而不是一个按下去必报错的按钮', async ({ page }) => {
  await openDictionary(page);

  await page.getByTestId('ingredient-search-input').fill('生抽');
  await page.getByTestId('ingredient-row-light_soy').click();
  await page.getByTestId('ingredient-edit-open-light_soy').click();

  const editor = page.getByTestId('ingredient-editor-light_soy');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('ingredient-nutrition-locked-edit-light_soy')).toBeVisible();
  await expect(page.getByTestId('ingredient-nutrition-suggest-edit-light_soy')).toHaveCount(0);
  // 只读态也说得清这是**成分表读数**而不是估算
  await page.getByTestId('ingredient-edit-cancel-light_soy').click();
  await expect(page.getByTestId('ingredient-nutrition-source-light_soy')).toContainText('成分表读数');
});

/**
 * 第六条（AC：手机 / 平板两版式都能用）：录入表单带四项营养也不横向溢出。
 * 两个 project（phone 390 / tablet 1024）都跑这条，右值取**当前视口宽度**。
 */
test('带四项营养的录入表单与详情卡都不横向溢出', async ({ page }) => {
  await openDictionary(page);

  await page.getByTestId('ingredient-create-open').click();
  await expect(page.getByTestId('ingredient-editor-new')).toBeVisible();
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const overflow = await page.evaluate(() => {
    const wide = [...document.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1);
    return wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 5);
  });
  expect(overflow).toEqual([]);
});

/**
 * 第七条（AC：「含估算」与「缺数据」是两句不同的话）：**营养弹层上真的说出两句**。
 *
 * 单测（`api/ingredient-nutrition.test.ts`）钉住了服务端那两个清单；这条验的是**界面把它们
 * 说成了两句不同的话**——估算项说「估算的、数字是参考」，缺数据项说「没算进上面的数字、偏低」。
 * 把两者合并成一句（“数字仅供参考”或“合计偏低”）都会在这条上红。
 *
 * 自建一道菜（用一条带估算营养的食材 + 一条完全没有营养的食材）：
 *   * 带估算的那条：走界面录入（点估算营养 → 自动预填四项 → 保存）；
 *   * 没有营养的那条：只填名字（缺营养是既有的合法状态）。
 * 收尾：取消餐槽 + 把自己建的那道菜**退役**（退役菜不进推荐池，不给后续 spec 留痕迹；
 * 菜谱没有删除接口，退役是仓库里既有的收尾方式，见 `recipe-library.spec.ts`）。
 */
test('营养弹层把「含估算」与「缺数据」说成两句不同的话', async ({ page }) => {
  const estimatedName = uniqueName('估算食材');
  const missingName = uniqueName('缺数据食材');
  const recipeName = uniqueName('估算菜');

  // ① 带估算营养的食材：走产品里的录入表单（点估算营养 → 自动预填四项 → 保存）
  await openDictionary(page);
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(estimatedName);
  await page.getByTestId('ingredient-nutrition-suggest-new').click();
  await expect(page.getByTestId('ingredient-nutrition-estimate-new')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ingredient-nutrition-new-energyKcal')).not.toHaveValue('');
  await page.getByTestId('ingredient-save-new').click();
  await expect.poll(async () => (await findIngredient(page, estimatedName))?.name, { timeout: 15_000 }).toBe(estimatedName);
  const estimated = (await findIngredient(page, estimatedName))!;

  // ② 完全没有营养的食材（只填名字 = 暂缺）
  await page.goto(`${ROOT_URL}/`);
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-ingredients-entry').click();
  await page.getByTestId('ingredient-create-open').click();
  await page.getByTestId('ingredient-name-new').fill(missingName);
  await page.getByTestId('ingredient-save-new').click();
  await expect.poll(async () => (await findIngredient(page, missingName))?.name, { timeout: 15_000 }).toBe(missingName);
  const missing = (await findIngredient(page, missingName))!;

  // ③ 用这两条食材建一道菜（走 API：本票不碰菜谱编辑器）
  const created = await page.request.post(`${ROOT_URL}/api/recipes`, {
    data: {
      name: recipeName,
      kind: 'veg',
      ingredients: [
        { ingredientId: estimated.id, adultGrams: 200 },
        { ingredientId: missing.id, adultGrams: 100 },
      ],
    },
  });
  expect(created.ok(), `建菜失败：HTTP ${created.status()}`).toBe(true);
  const recipeId = ((await created.json()) as { recipe: { id: string } }).recipe.id;

  // ④ 定一餐并打开营养弹层
  const listed = await page.request.get(`${ROOT_URL}/api/slots?days=7`);
  const { slots } = (await listed.json()) as { slots: { id: string; status: string }[] };
  const slot = slots.find((item) => item.status === 'undecided');
  expect(slot, '窗口内要有未定餐槽').toBeTruthy();
  const booked = await page.request.put(`${ROOT_URL}/api/slots/${slot!.id}`, {
    data: { diners: ['mom'], dishes: [{ recipeId }] },
  });
  expect(booked.ok()).toBe(true);

  try {
    await page.goto(`${ROOT_URL}/slot/${slot!.id}`);
    await expect(page.getByTestId('slot-view')).toBeVisible();
    await page.getByTestId('nutrition-button').click();
    await expect(page.getByTestId('nutrition-sheet')).toBeVisible({ timeout: 15_000 });

    // 两句**各自点名自己的那几项**，且不混说
    const estimatedBlock = page.getByTestId('nutrition-estimated');
    const missingBlock = page.getByTestId('nutrition-missing');
    await expect(estimatedBlock).toBeVisible();
    await expect(missingBlock).toBeVisible();

    await expect(estimatedBlock).toContainText(estimatedName);
    await expect(estimatedBlock).toContainText('估算');
    await expect(estimatedBlock).toContainText('参考');
    // 「含估算」那一句**不说**「没算进上面的数字」（它已经算进去了）
    await expect(estimatedBlock).not.toContainText('没算进上面的数字');
    await expect(estimatedBlock).not.toContainText(missingName);

    await expect(missingBlock).toContainText(missingName);
    await expect(missingBlock).toContainText('偏低');
    await expect(missingBlock).not.toContainText(estimatedName);

    // 注记按「本次读数里有没有估算项」换了措辞：不再说「取成分表平均值」
    await expect(page.getByTestId('nutrition-note')).toContainText('估算');

    // 逐道菜那一行也分得清：这一道里两种都有
    await expect(page.getByTestId(`nutrition-dish-${recipeId}`)).toContainText('估算');
  } finally {
    // 收尾：取消餐槽 + 把自己建的菜退役（退役菜不进推荐池）
    await page.request.delete(`${ROOT_URL}/api/slots/${slot!.id}`);
    await page.request.post(`${ROOT_URL}/api/recipes/${recipeId}/retire`, { data: {} });
  }
});
