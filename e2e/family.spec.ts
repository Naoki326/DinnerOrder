import { expect, test } from '@playwright/test';
import { E2E, ROOT_URL } from './test-env';

/**
 * 验收场景（本票部分）：无登录下切换当前身份并编辑画像（总纲 §2.4、§2.9）。
 * 主闭环的其余部分（餐槽/推荐/买菜清单）由后续工单按同样的形状补 S1–S10。
 *
 * 画像测试会改库，所以开工前先把要动的那几块改回种子态：同一轮里多个测试共享一个 webServer
 * （库在 webServer 启动时删过重建），先复原再断言就不依赖测试执行顺序。
 */
const SEED_DAD_LOVES = [
  { kind: 'ingredient', id: 'potato' },
  { kind: 'ingredient', id: 'beef_brisket' },
  { kind: 'recipe', id: 'tudouniuniu' },
];

test('切换当前身份即时生效、本设备持久、不跨设备共享（无登录无口令）', async ({ page, browser }) => {
  await page.goto(`${ROOT_URL}/`);

  // 无登录：打开就有身份，缺省是掌勺者（家里最常拿着手机安排的那个人）
  await expect(page.getByTestId('identity-chip')).toBeVisible();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');

  // 点头像列开切换器，挑「小宝」——切换即时生效，头部身份条立刻变
  await page.getByTestId('identity-chip').click();
  await expect(page.getByTestId('identity-sheet')).toBeVisible();
  await page.getByTestId('identity-option-xiaobao').click();
  await expect(page.getByTestId('identity-name')).toHaveText('小宝');

  // 本设备持久：刷新后还是小宝（没有登录态可依赖，所以它只能是设备本地的设置）
  await page.reload();
  await expect(page.getByTestId('identity-name')).toHaveText('小宝');

  // 不跨设备：**此刻**另一台手机打开还是缺省身份——这台设备刚切成小宝，
  // 所以「存成服务端全局」的实现会在这里得到小宝而失败。这一步必须紧跟在切换之后：
  // 若先在本设备切回妈妈再断言，「全局存储」也会给出妈妈，断言就失去判别力了。
  const otherPhone = await browser.newContext({ viewport: E2E.viewport });
  const otherPage = await otherPhone.newPage();
  await otherPage.goto(`${ROOT_URL}/`);
  await expect(otherPage.getByTestId('identity-name')).toHaveText('妈妈');
  await otherPhone.close();

  // 家人页认得当前身份：小宝那张卡标着「当前身份」，也能在家人页上一拍切换
  await page.getByRole('link', { name: /家人/ }).click();
  await expect(page.getByTestId('family-view')).toBeVisible();
  await expect(page.getByTestId('member-current-xiaobao')).toBeVisible();
  await page.getByTestId('member-switch-mom').click();
  await expect(page.getByTestId('identity-name')).toHaveText('妈妈');
  await expect(page.getByTestId('member-current-mom')).toBeVisible();
});

test('家人页编辑画像：忌口/爱吃条目可增删、出生年月可改', async ({ page }) => {
  // 先复原成种子态，让断言不依赖测试顺序与本轮之前的状态（webServer 启动时库是干净的）
  await page.request.patch(`${ROOT_URL}/api/members/dad`, {
    data: { avoid: [], loves: SEED_DAD_LOVES },
  });
  await page.request.patch(`${ROOT_URL}/api/members/dabao`, { data: { birthMonth: '2017-05' } });

  await page.goto(`${ROOT_URL}/family`);
  await expect(page.getByTestId('family-view')).toBeVisible();

  const avoidEntries = page.getByTestId('dad-avoid-entries');

  // --- 忌口增：搜别名「西红柿」也能选中规范名「番茄」（字典的别名归一） ---
  await expect(avoidEntries.getByText('无')).toBeVisible();
  await page.getByTestId('dad-avoid-input').fill('西红柿');
  await expect(page.getByTestId('dad-avoid-suggestion-tomato')).toBeVisible();
  await page.getByTestId('dad-avoid-suggestion-tomato').click();
  await expect(page.getByTestId('dad-avoid-entry-tomato')).toContainText('番茄');

  // 刷新后仍在：真的落库了，不是界面上的本地态
  await page.reload();
  await expect(page.getByTestId('dad-avoid-entry-tomato')).toBeVisible();

  // --- 忌口删 ---
  await page.getByTestId('dad-avoid-remove-tomato').click();
  await expect(page.getByTestId('dad-avoid-entry-tomato')).toBeHidden();
  await expect(avoidEntries.getByText('无')).toBeVisible();

  // --- 爱吃增：直接搜规范名 ---
  await page.getByTestId('dad-loves-input').fill('排骨');
  await page.getByTestId('dad-loves-suggestion-ingredient-pork_ribs').click();
  await expect(page.getByTestId('dad-loves-entry-ingredient-pork_ribs')).toContainText('猪排骨');
  await page.reload();
  await expect(page.getByTestId('dad-loves-entry-ingredient-pork_ribs')).toBeVisible();

  // --- 爱吃删：种子里的土豆还在，新加的排骨删掉 ---
  await page.getByTestId('dad-loves-remove-ingredient-pork_ribs').click();
  await expect(page.getByTestId('dad-loves-entry-ingredient-pork_ribs')).toBeHidden();
  // 用 testid 而不是 getByText：爱吃现在是**混合粒度**（食材 + 具体菜，#15 接通），
  // getByText('土豆') 会同时命中「土豆」食材与「土豆炖牛腩」这道菜（子串匹配 → strict 冲突）
  await expect(page.getByTestId('dad-loves-entry-ingredient-potato')).toBeVisible();

  // --- 出生年月可改（#16 份量引擎按它现算年龄分带） ---
  const birth = page.getByTestId('member-birth-dabao');
  await expect(birth).toHaveValue('2017-05');
  await birth.fill('2018-03');
  await expect(birth).toHaveValue('2018-03');
  await page.reload();
  await expect(page.getByTestId('member-birth-dabao')).toHaveValue('2018-03');

  // 复原种子态：后续工单的 E2E 会看到这个库（比如份量折算依赖小孩出生年月）
  await page.request.patch(`${ROOT_URL}/api/members/dabao`, { data: { birthMonth: '2017-05' } });
});

test('画像条目落在食材字典上，且不吃手机宽度', async ({ page }) => {
  await page.goto(`${ROOT_URL}/family`);
  await expect(page.getByTestId('member-xiaobao')).toBeVisible();

  // 种子里小宝忌贝类、虾，爱吃玉米/猪排骨/鸡翅——忌口与爱吃都指向字典规范名
  await expect(page.getByTestId('xiaobao-avoid-entry-shellfish')).toContainText('贝类');
  await expect(page.getByTestId('xiaobao-avoid-entry-shrimp')).toContainText('虾');
  await expect(page.getByTestId('xiaobao-loves-entry-ingredient-corn')).toBeVisible();

  // 爱吃是混合粒度（总纲 §2.9）：小宝还爱吃「玉米胡萝卜排骨汤」这道菜本身（#15 随菜谱表补录）
  await expect(page.getByTestId('xiaobao-loves-entry-recipe-yumihuluobogutang')).toContainText('玉米胡萝卜排骨汤');

  // 小孩卡片显示按出生年月现算的年龄；大人显示「大人」（都带性别）
  await expect(page.getByTestId('member-subtitle-xiaobao')).toContainText('岁');
  await expect(page.getByTestId('member-subtitle-mom')).toHaveText('大人 · 女');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390);
});
