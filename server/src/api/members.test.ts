import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';

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
    expect(xiaobao.loves.map((entry) => entry.name)).toEqual(['玉米', '猪排骨', '鸡翅']);

    // 妈妈忌口（硬过滤的种子数据，原型一致）
    const mom = await getMember('mom');
    expect(mom.avoid.map((entry) => entry.name)).toEqual(['动物内脏']);
  });

  it('不存在的家人返回 404 而不是空画像', async () => {
    harness = createTestHarness();

    const { status, body } = await harness.json<{ error: string }>('/api/members/nobody');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});

/**
 * 画像编辑（总纲 §2.9）：忌口/爱吃条目可增删、出生年月可改。
 * 列表按**整体替换**语义提交——家人手机上改完点保存，客户端发的是当前完整的清单。
 */
describe('画像编辑', () => {
  interface PatchOptions {
    birthMonth?: string | null;
    avoid?: string[];
    loves?: string[];
  }

  async function patchMember(id: string, patch: PatchOptions) {
    return await harness.json<{ member?: MemberJson; error?: string; ingredientId?: string }>(`/api/members/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

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

  it('爱吃可增可删，粒度是食材（条目带规范名）', async () => {
    harness = createTestHarness();

    const { status, body } = await patchMember('dad', { loves: ['pork_ribs', 'chicken_legs'] });
    expect(status).toBe(200);
    expect(body.member?.loves).toEqual([
      { ingredientId: 'pork_ribs', name: '猪排骨' },
      { ingredientId: 'chicken_legs', name: '鸡腿' },
    ]);

    await patchMember('dad', { loves: [] });
    expect((await getMember('dad')).loves).toEqual([]);
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
