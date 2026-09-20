import { expect, test, type Page } from '@playwright/test';
import { ROOT_URL } from './test-env';

/**
 * 改基本资料（名字 / 头像 / 性别）的端到端链路。
 *
 * 这三栏原先只在「新增家人」表单里填得到，之后**永远改不了**：
 * 名字打错字、头像挑错、性别录反都只能删了重建，而重建会丢掉这位家人的忌口/爱吃与餐史归属。
 * 性别尤其不是小事——**6–17 岁小孩的份量系数按性别相差约 14%**（WS/T 554 表 1：
 * 6–8 岁男 0.756 / 女 0.861）。
 *
 * 两条纪律（与 members.spec 同一套）：
 *   * 文件名 `profile.spec.ts` 排在 `meal.spec.ts` **之后**（`m` < `p`）：本 spec 往餐槽写留痕，
 *     而 meal.spec 断言「未定餐槽的留痕为空」——留痕 append-only，清不掉。
 *     排在 `review` 之前无所谓（那个 spec 不依赖「留痕为空」）。
 *   * **只用自己造的家人**：种子的 mom/dad/dabao/xiaobao 被 family/views 断言着
 *     （views 的三视图对照会用「不传名单 = 全员」比对推荐结果），改种子会打红那边。
 */

interface MemberJson {
  id: string;
  name: string;
  emoji: string;
  kind: 'adult' | 'child';
  gender: 'male' | 'female';
  birthMonth: string | null;
  isCook: boolean;
}

async function listMembers(page: Page): Promise<MemberJson[]> {
  const response = await page.request.get(`${ROOT_URL}/api/members`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { members: MemberJson[] }).members;
}

async function readMember(page: Page, id: string): Promise<MemberJson> {
  const response = await page.request.get(`${ROOT_URL}/api/members/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { member: MemberJson }).member;
}

/** 造一位临时的家人（本 spec 只动自己造的，不碰种子） */
async function makeMember(page: Page, input: Partial<MemberJson> = {}): Promise<MemberJson> {
  const response = await page.request.post(`${ROOT_URL}/api/members`, {
    data: {
      name: input.name ?? '临时家人',
      emoji: input.emoji ?? '🧑',
      kind: input.kind ?? 'child',
      gender: input.gender ?? 'female',
      // 小孩必须有出生年月（份量分带没有依据就拒收）
      ...(input.kind === 'adult' ? {} : { birthMonth: input.birthMonth ?? '2018-03' }),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { member: MemberJson }).member;
}

test.afterEach(async ({ page }) => {
  for (const member of await listMembers(page)) {
    if (['mom', 'dad', 'dabao', 'xiaobao'].includes(member.id)) continue;
    await page.request.delete(`${ROOT_URL}/api/members/${member.id}`);
  }
});

test('改名字与头像：就地编辑即存，刷新后还在（原先只能在新增时填）', async ({ page }) => {
  const member = await makeMember(page, { name: '小明' });

  await page.goto(`${ROOT_URL}/family`);
  await expect(page.getByTestId(`member-${member.id}`)).toBeVisible();

  // 改名字：输入框是本地草稿，失焦才提交（打字途中不该每敲一个字发一次请求）
  const nameInput = page.getByTestId(`member-name-input-${member.id}`);
  await nameInput.scrollIntoViewIfNeeded();
  await nameInput.fill('小明子');
  await nameInput.blur();

  await expect
    .poll(async () => (await readMember(page, member.id)).name, { message: '名字没存上' })
    .toBe('小明子');

  // 改头像：点快选里的 👦（一拍生效）
  await page.getByTestId(`member-emoji-${member.id}-👦`).click();
  await expect
    .poll(async () => (await readMember(page, member.id)).emoji, { message: '头像没存上' })
    .toBe('👦');

  // 刷新后仍是新的（不是只改了本地态）
  await page.reload();
  await expect(page.getByTestId(`member-name-input-${member.id}`)).toHaveValue('小明子');
});

test('改性别：点一下就落库，卡片副标题跟着变', async ({ page }) => {
  const member = await makeMember(page, { kind: 'child', gender: 'female', birthMonth: '2016-01' });

  await page.goto(`${ROOT_URL}/family`);
  const female = page.getByTestId(`member-gender-female-${member.id}`);
  const male = page.getByTestId(`member-gender-male-${member.id}`);
  await male.scrollIntoViewIfNeeded();

  // 初始是女
  await expect(female).toHaveAttribute('aria-pressed', 'true');

  await male.click();

  await expect
    .poll(async () => (await readMember(page, member.id)).gender, { message: '性别没存上' })
    .toBe('male');
  await expect(male).toHaveAttribute('aria-pressed', 'true');
  await expect(female).toHaveAttribute('aria-pressed', 'false');
  // 副标题是「小孩 · N 岁 · 男」——改完当场看得见
  await expect(page.getByTestId(`member-subtitle-${member.id}`)).toContainText('男');
});

test('已进分性别档位的小孩：提示说清「选错会让克数一直偏」', async ({ page }) => {
  // 6 岁以上才进分性别的档（WS/T 554 的表 1 从 6 岁起分男女）
  const big = await makeMember(page, { kind: 'child', gender: 'male', birthMonth: '2016-01' });
  const small = await makeMember(page, { kind: 'child', gender: 'male', birthMonth: '2024-01' });

  await page.goto(`${ROOT_URL}/family`);

  // 学龄期：说清代价
  const bigHint = page.getByTestId(`member-gender-hint-${big.id}`);
  await bigHint.scrollIntoViewIfNeeded();
  await expect(bigHint).toContainText('克数一直偏');

  // 学龄前：如实说「现在还没到这个年龄带，选错不影响读数」——不吓唬人
  const smallHint = page.getByTestId(`member-gender-hint-${small.id}`);
  await smallHint.scrollIntoViewIfNeeded();
  await expect(smallHint).toContainText('不影响读数');
});

test('性别改成男之后，份量读数照常算得出来（改资料没弄坏折算链路）', async ({ page }) => {
  const member = await makeMember(page, { kind: 'child', gender: 'female', birthMonth: '2014-06' });

  // 先看一眼改之前的读数
  const before = await page.request.post(`${ROOT_URL}/api/portion/preview`, {
    data: { diners: [member.id], dishes: [{ recipeId: 'hongshaopaigu' }] },
  });
  expect(before.ok(), await before.text()).toBe(true);

  // 改成男
  const patched = await page.request.patch(`${ROOT_URL}/api/members/${member.id}`, { data: { gender: 'male' } });
  expect(patched.ok(), await patched.text()).toBe(true);

  const after = await page.request.post(`${ROOT_URL}/api/portion/preview`, {
    data: { diners: [member.id], dishes: [{ recipeId: 'hongshaopaigu' }] },
  });
  expect(after.ok(), await after.text()).toBe(true);
  const body = (await after.json()) as { portion: { diners: { factor: number; gender?: string }[] } };

  // 12 岁（2014-06 出生）已进分性别的档：改成男之后系数应当**真的变了**
  // （这就是「性别不是标注」的端到端证据，不是只看接口回执）
  const beforeBody = (await before.json()) as { portion: { diners: { factor: number }[] } };
  expect(beforeBody.portion.diners[0]?.factor).not.toBe(body.portion.diners[0]?.factor);
});
