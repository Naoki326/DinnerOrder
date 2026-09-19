import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { pickPoolSelection } from '../llm/prompt.js';
import { feedbackSummary } from '../domain/feedback.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

// 线上形状从 wire-types 取（与前端同一处定义）：测试断言的形状必须就是契约的形状，
// 手抄一份的话，接口改了测试还绿——那是测试在自我安慰
import type { MemberProfile as MemberJson } from '../wire-types.js';

async function listMembers(): Promise<MemberJson[]> {
  const { status, body } = await harness.json<{ members: MemberJson[] }>('/api/members');
  expect(status).toBe(200);
  return body.members;
}

async function getMember(id: string): Promise<MemberJson> {
  const { status, body } = await harness.json<{ member: MemberJson }>(`/api/members/${id}`);
  expect(status).toBe(200);
  return body.member;
}

/**
 * 家人画像（总纲 §2.9、§3）：大人/小孩、男/女、出生年月、忌口[]、爱吃[]。
 * 忌口与爱吃建模不对称——忌口是硬过滤（条目只指向食材），爱吃是软加分（可食材可具体菜）。
 */
describe('家人', () => {
  it('真实家人随库就位，小孩含出生年月', async () => {
    harness = createTestHarness();

    const members = await listMembers();
    expect(members.map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);

    const mom = members.find((member) => member.id === 'mom')!;
    expect(mom).toMatchObject({ kind: 'adult', gender: 'female', isCook: true, birthMonth: null });

    const dabao = members.find((member) => member.id === 'dabao')!;
    expect(dabao).toMatchObject({ kind: 'child', gender: 'male', birthMonth: '2017-05' });

    const xiaobao = members.find((member) => member.id === 'xiaobao')!;
    expect(xiaobao.birthMonth).toBe('2021-09');
  });

  it('画像带忌口与爱吃，条目都指向食材字典的规范名', async () => {
    harness = createTestHarness();

    const xiaobao = await getMember('xiaobao');
    expect(xiaobao.avoid.map((entry) => entry.name)).toEqual(['贝类', '虾']);
    expect(xiaobao.avoid.map((entry) => entry.ingredientId)).toEqual(['shellfish', 'shrimp']);
    // 爱吃是混合粒度（总纲 §2.9）：食材粒度在前（#14 的种子），菜粒度在后（#15 随菜谱表补录）
    expect(xiaobao.loves.map((entry) => entry.name)).toEqual(['玉米', '猪排骨', '鸡翅', '玉米胡萝卜排骨汤']);
    expect(xiaobao.loves.map((entry) => entry.kind)).toEqual([
      'ingredient',
      'ingredient',
      'ingredient',
      'recipe',
    ]);

    // 妈妈忌口（硬过滤的种子数据，原型一致）
    const mom = await getMember('mom');
    expect(mom.avoid.map((entry) => entry.name)).toEqual(['动物内脏']);
    // 妈妈爱吃清蒸鲈鱼：菜粒度条目带菜名（原型 PEOPLE 里的菜名，001 说好随菜谱表一起录）
    expect(mom.loves).toContainEqual({ kind: 'recipe', id: 'qingzhengluyu', name: '清蒸鲈鱼' });
  });

  it('不存在的家人返回 404 而不是空画像', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string }>('/api/members/nobody');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});

interface PatchOptions {
  birthMonth?: string | null;
  avoid?: string[];
  loves?: { kind: 'ingredient' | 'recipe'; id: string }[];
}

async function patchMember(id: string, patch: PatchOptions) {
  return await harness.json<{
    member?: MemberJson;
    error?: string;
    ingredientId?: string;
    recipeId?: string;
  }>(`/api/members/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/**
 * 画像编辑（总纲 §2.9）：忌口/爱吃条目可增删、出生年月可改。
 * 列表按**整体替换**语义提交——家人手机上改完点保存，客户端发的是当前完整的清单。
 */
describe('画像编辑', () => {

  it('忌口可增可删，改完立即从查询结果里看得出来', async () => {
    harness = createTestHarness();

    // 增：妈妈原本忌动物内脏，再加上辣椒
    const added = await patchMember('mom', { avoid: ['offal', 'chili'] });
    expect(added.status).toBe(200);
    expect(added.body.member?.avoid.map((entry) => entry.name)).toEqual(['动物内脏', '辣椒']);

    const afterAdd = await getMember('mom');
    expect(afterAdd.avoid.map((entry) => entry.ingredientId)).toEqual(['offal', 'chili']);

    // 删：只剩辣椒
    await patchMember('mom', { avoid: ['chili'] });
    const afterRemove = await getMember('mom');
    expect(afterRemove.avoid.map((entry) => entry.name)).toEqual(['辣椒']);
  });

  it('爱吃可增可删，食材与菜两种粒度都能存（#15 接通菜粒度）', async () => {
    harness = createTestHarness();

    const { status, body } = await patchMember('dad', {
      loves: [
        { kind: 'ingredient', id: 'pork_ribs' },
        { kind: 'recipe', id: 'hongshaopaigu' },
        { kind: 'ingredient', id: 'chicken_legs' },
      ],
    });
    expect(status).toBe(200);
    expect(body.member?.loves).toEqual([
      { kind: 'ingredient', id: 'pork_ribs', name: '猪排骨' },
      { kind: 'recipe', id: 'hongshaopaigu', name: '红烧排骨' },
      { kind: 'ingredient', id: 'chicken_legs', name: '鸡腿' },
    ]);

    // 两种粒度各自独立清理：传空清单就都清掉
    await patchMember('dad', { loves: [] });
    expect((await getMember('dad')).loves).toEqual([]);
  });

  it('爱吃指向不存在的菜被拒绝（与食材同口径，不留悬空条目）', async () => {
    harness = createTestHarness();
    const before = await getMember('dad');

    const { status, body } = await patchMember('dad', { loves: [{ kind: 'recipe', id: '不存在的菜' }] });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_recipe');
    expect(body.recipeId).toBe('不存在的菜');
    expect(await getMember('dad')).toEqual(before);
  });

  it('同一目标填两次只留一条（食材与菜的各留一条）', async () => {
    harness = createTestHarness();

    await patchMember('dad', {
      loves: [
        { kind: 'ingredient', id: 'tofu' },
        { kind: 'ingredient', id: 'tofu' },
        { kind: 'recipe', id: 'mapodoufu' },
      ],
    });
    expect((await getMember('dad')).loves).toEqual([
      { kind: 'ingredient', id: 'tofu', name: '豆腐' },
      { kind: 'recipe', id: 'mapodoufu', name: '麻婆豆腐' },
    ]);
  });

  it('出生年月可改（小孩按新值分带，#16 份量引擎要用）', async () => {
    harness = createTestHarness();

    const { status, body } = await patchMember('dabao', { birthMonth: '2018-03' });
    expect(status).toBe(200);
    expect(body.member?.birthMonth).toBe('2018-03');
    expect((await getMember('dabao')).birthMonth).toBe('2018-03');
  });

  it('小孩不能被清空出生年月——分带折算没了依据', async () => {
    harness = createTestHarness();

    const { status, body } = await patchMember('xiaobao', { birthMonth: null });
    expect(status).toBe(400);
    expect(body.error).toBe('birth_month_required');
    // 拒绝就是拒绝，库里不能被动过
    expect((await getMember('xiaobao')).birthMonth).toBe('2021-09');
  });

  it('出生年月必须是 YYYY-MM，乱填直接拒绝（错误体带得清哪一项）', async () => {
    harness = createTestHarness();

    for (const bad of ['2018-13', '2018/03', '18-3', '今年']) {
      const { status, body } = await harness.json<{ error: string; issues?: { path: string; message: string }[] }>(
        '/api/members/dabao',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ birthMonth: bad }),
        },
      );
      expect(status, `应拒绝 ${bad}`).toBe(400);
      expect(body.error, `应拒绝 ${bad}`).toBe('invalid_request');
      // 界面要说清是出生年月这一项坏了，而不是笼统一句失败
      expect(body.issues?.[0]?.path, `应指出字段 ${bad}`).toBe('birthMonth');
    }
    expect((await getMember('dabao')).birthMonth).toBe('2017-05');
  });

  it('指向字典外的食材被拒绝，且不改动已有画像', async () => {
    harness = createTestHarness();
    const before = await getMember('dad');

    const { status, body } = await patchMember('dad', { avoid: ['巧克力'] });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_ingredient');
    expect(body.ingredientId).toBe('巧克力');

    expect(await getMember('dad')).toEqual(before);
  });

  it('重复条目只留一条（清单是集合，不是流水）', async () => {
    harness = createTestHarness();

    await patchMember('xiaobao', { avoid: ['shellfish', 'shellfish', 'shrimp'] });
    expect((await getMember('xiaobao')).avoid.map((entry) => entry.ingredientId)).toEqual(['shellfish', 'shrimp']);
  });

  it('改不存在的家人返回 404', async () => {
    harness = createTestHarness();

    const { status } = await patchMember('nobody', { birthMonth: '2018-03' });
    expect(status).toBe(404);
  });
});

/** `POST /api/members` 的直打（新增家人的唯一入口） */
async function postMember(payload: Record<string, unknown>) {
  return await harness.json<{
    member?: MemberJson;
    error?: string;
    issues?: { path: string; message: string }[];
    birthMonth?: string;
  }>('/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 造一个家人并返回落库后的画像；必填项缺省给全，用例只覆盖自己关心的那一项 */
async function makeMember(overrides: Record<string, unknown> = {}): Promise<MemberJson> {
  const { status, body } = await postMember({
    name: '姥姥',
    emoji: '👵',
    kind: 'adult',
    gender: 'female',
    ...overrides,
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.member!;
}

async function deleteMember(id: string) {
  return await harness.json<{ ok?: boolean; member?: MemberJson; error?: string }>(`/api/members/${id}`, {
    method: 'DELETE',
  });
}

/** 让 fake 像真模型那样「从池中选」：推荐管线走通，且 prompt 内容可断言 */
function scriptRecommendation(): void {
  harness.llm.setCompletion((request) => pickPoolSelection(request.prompt) ?? '{"dishes":[]}');
}

/** 打一次推荐并把它收到的 prompt 取回来——「这一餐谁参与过滤/加分」全在那里面 */
async function recommendPrompt(): Promise<string> {
  const { status } = await harness.json('/api/slots/2025-06-01:dinner/recommendation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(status).toBe(200);
  const call = harness.llm.completionCalls.at(-1);
  if (!call) throw new Error('推荐没有调用 LLM');
  return call.request.prompt;
}

/**
 * 新增家人（本票）：家人页顶部的一级表单，必填名字 + 头像 + 大人/小孩 + 性别；小孩另需出生年月。
 *
 * 为什么大人也要必填性别：**6–17 岁小孩的折算系数按性别相差 14%**（6–8 岁：男 0.756 / 女 0.861），
 * 而 DB 里 gender 是 NOT NULL——不靠默认值，让录入时就问清楚。
 */
describe('新增家人', () => {
  it('必填项齐了就进列表，排在最后，默认不是掌勺者', async () => {
    harness = createTestHarness();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    expect(created).toMatchObject({
      name: '姥姥',
      emoji: '👵',
      kind: 'adult',
      gender: 'female',
      birthMonth: null,
      isCook: false,
      avoid: [],
      loves: [],
    });
    // id 由服务端生成，不可与种子/历史快照里的 id 撞车
    expect(created.id).toMatch(/^m_[0-9a-f-]{8,}$/);

    // 列表里排在最后（sort_order = MAX + 1），种子的顺序不受扰动
    const members = await listMembers();
    expect(members.map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝', '姥姥']);
    expect((await getMember(created.id)).name).toBe('姥姥');

    // 后补的画像（忌口/爱吃/出生年月）走既有的 PATCH 入口，不重做那套 UI
    await patchMember(created.id, { avoid: ['offal'] });
    expect((await getMember(created.id)).avoid.map((entry) => entry.ingredientId)).toEqual(['offal']);
  });

  it('名字、头像、大人/小孩、性别各缺一项就被拦，错误体指认字段', async () => {
    harness = createTestHarness();

    const full = { name: '姥姥', emoji: '👵', kind: 'adult', gender: 'female' };
    for (const key of ['name', 'emoji', 'kind', 'gender'] as const) {
      const payload: Record<string, unknown> = { ...full };
      delete payload[key];
      const { status, body } = await postMember(payload);
      expect(status, `缺 ${key} 应被拦`).toBe(400);
      expect(body.error, `缺 ${key} 应是形状错误`).toBe('invalid_request');
      expect(body.issues?.[0]?.path, `缺 ${key} 应指出字段`).toBe(key);
    }
    // 一项都没落库
    expect((await listMembers()).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);
  });

  it('名字只有空白 = 空名字（服务端拦，客户端另有表单层一道）', async () => {
    harness = createTestHarness();

    const { status, body } = await postMember({ name: '   ', emoji: '👵', kind: 'adult', gender: 'female' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.issues?.[0]?.path).toBe('name');
    expect((await listMembers()).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);
  });

  it('小孩没有出生年月被拦（份量分带没有依据），给了才收', async () => {
    harness = createTestHarness();

    const missing = await postMember({ name: '二宝', emoji: '👶', kind: 'child', gender: 'male' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_request');
    expect(missing.body.issues?.[0]?.path).toBe('birthMonth');
    expect(missing.body.issues?.[0]?.message).toContain('出生年月');

    const created = await makeMember({ name: '二宝', emoji: '👶', kind: 'child', gender: 'male', birthMonth: '2024-06' });
    expect(created).toMatchObject({ kind: 'child', gender: 'male', birthMonth: '2024-06' });
  });

  it('出生年月必须是 YYYY-MM；大人可以留空也可以录', async () => {
    harness = createTestHarness();

    const bad = await postMember({
      name: '二宝',
      emoji: '👶',
      kind: 'child',
      gender: 'male',
      birthMonth: '2024/06',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');
    expect(bad.body.issues?.[0]?.path).toBe('birthMonth');

    const adult = await makeMember({ name: '姥姥', emoji: '👵', birthMonth: '1962-03' });
    expect(adult.birthMonth).toBe('1962-03');
    const noMonth = await makeMember({ name: '姥爷', emoji: '👴', gender: 'male' });
    expect(noMonth.birthMonth).toBeNull();
  });

  it('新增后立即可用：能被选为用餐者、能切身份', async () => {
    harness = createTestHarness();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    const { status, body } = await harness.json<{
      slot?: { menu?: { diners: { memberId: string }[] } };
      error?: string;
      memberId?: string;
    }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: [created.id, 'mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.slot?.menu?.diners.map((diner) => diner.memberId)).toEqual([created.id, 'mom']);
  });

  it('重名不被拒绝（名字是标签，id 才是身份）', async () => {
    harness = createTestHarness();

    const first = await makeMember({ name: '姥姥', emoji: '👵' });
    const second = await makeMember({ name: '姥姥', emoji: '👵' });
    expect(second.id).not.toBe(first.id);
    expect((await listMembers()).filter((member) => member.name === '姥姥')).toHaveLength(2);
  });
});

/**
 * 删除家人（本票）= **软删除**：从列表消失、不再进任何名单，但历史一行不丢。
 * 硬删会连带删掉 `dish_feedback`（CASCADE）——那是「历史保留」最贵的一处；
 * 而 `meal_event_diners` 存的是姓名/头像快照，本来就不受影响。
 */
describe('删除家人（软删除）', () => {
  it('删了就从列表消失、单查 404，但行还在库里（画像条目也保留）', async () => {
    harness = createTestHarness();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    await patchMember(created.id, { avoid: ['offal'] });

    const { status, body } = await deleteMember(created.id);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.member?.name).toBe('姥姥');

    // 从列表消失（这是「删掉」的落点：推荐/换菜/定餐编辑器都从这一个口取名单）
    expect((await listMembers()).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝']);
    const single = await harness.json<{ error: string }>(`/api/members/${created.id}`);
    expect(single.status).toBe(404);

    // 软删除：行没删，只是打了时间戳；画像条目也留着（历史完整，将来要恢复不必重建）
    const row = harness.db.prepare('SELECT deleted_at FROM members WHERE id = ?').get(created.id) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM member_avoid WHERE member_id = ?').get(created.id),
    ).toEqual({ n: 1 });
  });

  it('删了之后忌口与爱吃不再参与推荐（同一次请求前后对比）', async () => {
    harness = createTestHarness();
    scriptRecommendation();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    await patchMember(created.id, { avoid: ['pork_ribs'], loves: [{ kind: 'ingredient', id: 'beef_brisket' }] });

    // 在用的家人：硬过滤（忌猪排骨 → 红烧排骨不入池）、软加分（爱吃牛腩）、画像段都在 prompt 里
    const before = await recommendPrompt();
    expect(before).toContain('姥姥');
    expect(before).toContain('牛腩');
    expect(before).not.toContain('红烧排骨');

    await deleteMember(created.id);

    // 删掉的家人：不在名单、忌口不再排菜、爱吃不再加分——同一次请求（默认全员）就看得出来
    const after = await recommendPrompt();
    expect(after).not.toContain('姥姥');
    expect(after).toContain('红烧排骨');
  });

  it('历史反馈仍在：已删家人点过的踩照旧把这道菜留在冷藏期', async () => {
    harness = createTestHarness();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    await harness.json('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: [created.id, 'mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    const write = await harness.json('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slotId: '2025-06-01:dinner',
        recipeId: 'hongshaopaigu',
        memberId: created.id,
        verdict: 'dislike',
        tags: ['太油'],
      }),
    });
    expect(write.status).toBe(200);

    await deleteMember(created.id);

    // 软删除相对硬删的核心收益：反馈行还在（硬删的 CASCADE 会把它带走）
    const { status, body } = await harness.json<{
      feedback: { memberId: string; memberName: string; recipeId: string; verdict: string; tags: string[] }[];
      cooling: { recipeId: string; until: string }[];
    }>('/api/feedback?days=30');
    expect(status).toBe(200);
    const kept = body.feedback.find((item) => item.memberId === created.id);
    expect(kept).toMatchObject({ memberName: '姥姥', recipeId: 'hongshaopaigu', verdict: 'dislike', tags: ['太油'] });
    // **判定**：那道菜确实被这一家人否决过（任一本餐用餐者点踩即冷藏，ADR-0005 布尔语义），
    // 删掉的是「这个人从此不再参与」，不是「那一顿饭没发生过」。
    expect(body.cooling.map((dish) => dish.recipeId)).toContain('hongshaopaigu');

    // 同理进近 30 天反馈摘要（它与冷藏期是反馈的两条不同出口，ADR-0005）：
    // 反驳「他人都删了，删了就当他没说过」——那道菜确实被说过「太油」，摘要就是这种历史事实的聚合。
    expect(feedbackSummary(harness.db, harness.clock).join('\n')).toContain('姥姥');

    // 但不能再代表他说话：删了就是删了
    const again = await harness.json<{ error: string; memberId?: string }>('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slotId: '2025-06-01:dinner',
        recipeId: 'hongshaopaigu',
        memberId: created.id,
        verdict: 'like',
      }),
    });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ error: 'unknown_member', memberId: created.id });
  });

  it('已删家人不能再作为用餐者：定餐、推荐与份量预览报 unknown_member，历史菜单按快照照读', async () => {
    harness = createTestHarness();

    // 用一个**小孩**：软删除若把画像一起拿走，历史菜单的份量会退回成人份（远大于实际），
    // 所以这一条同时盯「写入口拦住」与「历史读数一字不改」。
    const created = await makeMember({ name: '二宝', emoji: '👶', kind: 'child', gender: 'male', birthMonth: '2021-09' });
    const booked = await harness.json<{
      slot: { portion: { diners: { memberId: string; bandId: string; factor: number }[] } };
    }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: [created.id, 'mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(booked.status).toBe(200);
    const bandBefore = booked.body.slot.portion.diners.find((diner) => diner.memberId === created.id);
    expect(bandBefore?.bandId).toBe('preschool_2_3');

    await deleteMember(created.id);

    // 写入口：显式名单里出现已删的人 = 给错了，明确报错（与「从来没有过这个人」同一语义）
    const booking = await harness.json<{ error: string; memberId?: string }>('/api/slots/2025-06-01:dinner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: [created.id], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(booking.status).toBe(400);
    expect(booking.body).toMatchObject({ error: 'unknown_member', memberId: created.id });

    const preview = await harness.json<{ error: string; memberId?: string }>('/api/portion/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: [created.id], dishes: [{ recipeId: 'hongshaopaigu' }] }),
    });
    expect(preview.status).toBe(400);
    expect(preview.body).toMatchObject({ error: 'unknown_member', memberId: created.id });

    // 推荐也走同一个显式名单校验（是推荐还是定餐，已删的人都不能被「临时改成吃这一顿的人」）
    const recommendation = await harness.json<{ error: string; memberId?: string }>(
      '/api/slots/2025-06-01:dinner/recommendation',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diners: [created.id] }),
      },
    );
    expect(recommendation.status).toBe(400);
    expect(recommendation.body).toMatchObject({ error: 'unknown_member', memberId: created.id });

    // 历史菜单读得出来（名单是当时的快照），份量也照旧：软删除保留了画像，
    // 所以小宝那 0.408 的折算系数仍然算得出来——这是「历史必须完好」最硬的一条
    const { status, body } = await harness.json<{
      slot: {
        menu?: { diners: { memberId: string; name: string }[] };
        portion?: { diners: { memberId: string; name: string; bandId: string; factor: number; note: string | null }[] };
      };
    }>('/api/slots/2025-06-01:dinner');
    expect(status).toBe(200);
    expect(body.slot.menu?.diners.map((diner) => diner.name)).toEqual(['二宝', '妈妈']);
    const orphan = body.slot.portion?.diners.find((diner) => diner.memberId === created.id);
    expect(orphan).toMatchObject({ name: '二宝', bandId: 'preschool_2_3' });
    expect(orphan?.factor).toBeCloseTo(0.408, 6);
    // 他不是「查不到」的孤儿——画像还在，所以没有那句成人份兜底的说明
    expect(orphan?.note).toBeNull();
  });

  it('已删家人改不了画像、也删不了第二遍（删了就是删了）', async () => {
    harness = createTestHarness();

    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    await deleteMember(created.id);

    expect((await patchMember(created.id, { avoid: ['offal'] })).status).toBe(404);
    expect((await deleteMember(created.id)).status).toBe(404);
    expect((await deleteMember('nobody')).status).toBe(404);
  });

  /**
   * 编辑器给出的那条出路，在服务端这一半是通的：把已删家人从名单里去掉后，**同一个餐槽**
   * 照常存得回去（新的留痕事件只记剩下的人）。前一条测试钉的是「显式名单含已删 → 400」
   * 这个正确的拒绝；这一条钉的是拒绝之后用户真的能走出去，而不是被卡在「既算不出份量也存不回去」。
   */
  it('把已删家人从名单里去掉后，这一餐照常存得回去', async () => {
    harness = createTestHarness();
    const created = await makeMember({ name: '姥姥', emoji: '👵' });
    const booked = await harness.json<{ slot: { menu: { diners: { memberId: string }[] } } }>(
      '/api/slots/2025-06-01:dinner',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diners: [created.id, 'mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
      },
    );
    expect(booked.status).toBe(200);

    await deleteMember(created.id);

    // 名单里少了他，同一道菜、同一个餐槽：不是 400，而是新的一条留痕
    const after = await harness.json<{ slot: { menu: { diners: { memberId: string; name: string }[] } } }>(
      '/api/slots/2025-06-01:dinner',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'hongshaopaigu' }] }),
      },
    );
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.slot.menu.diners.map((diner) => diner.memberId)).toEqual(['mom']);

    const reread = await harness.json<{ history: { type: string; diners: { memberId: string }[] }[] }>(
      '/api/slots/2025-06-01:dinner',
    );
    // 新的一条留痕只记剩下的人；而历史没被改写：上一条里他还在（append-only）
    expect(reread.body.history.at(-1)?.diners.map((diner) => diner.memberId)).toEqual(['mom']);
    expect(reread.body.history[0]?.diners.map((diner) => diner.memberId)).toEqual([created.id, 'mom']);
  });

  it('删掉后可以再建同名家人（名字没有 UNIQUE 约束，删掉的不会永久占位）', async () => {
    harness = createTestHarness();

    const first = await makeMember({ name: '姥姥', emoji: '👵' });
    await deleteMember(first.id);
    const second = await makeMember({ name: '姥姥', emoji: '👵' });

    expect((await listMembers()).map((member) => member.name)).toEqual(['妈妈', '爸爸', '大宝', '小宝', '姥姥']);
    expect(second.id).not.toBe(first.id);
  });
});
