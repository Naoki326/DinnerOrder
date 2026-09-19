import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { parsePromptPool, parsePromptStructure, pickPoolSelection } from '../llm/prompt.js';
import type {
  MealEvent,
  MealRecommendation,
  RecipeOrigin,
  SlotWithPortion,
  SlotsResponse,
} from '../wire-types.js';

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 整餐推荐管线（总纲 §4、ADR-0001、spec S1/S6/S7）。
 *
 * 测试形状：**prompt 内容是对「LLM 被问了什么」的合法外部断言**——池子、结构、近 7 天已吃
 * 都是契约的一部分（ADR-0001：LLM 只从池中选，所以池子就是它的输入面）。所以这里既断言
 * HTTP 出参，也从 `harness.llm.completionCalls` 的 prompt 里读池子与结构。
 *
 * 时间基准：注入时钟默认 2025-06-01T10:00Z（家庭时区 6/1 18:00）→ 目标餐槽 6/1 晚餐，6 月。
 */
const SLOT = '2025-06-01:dinner';

interface RecommendationError {
  error: string;
  memberId?: string;
  id?: string;
}

async function recommend(payload: unknown = {}): Promise<{
  status: number;
  body: MealRecommendation;
  error?: RecommendationError;
}> {
  const { status, body } = await harness.json<{ recommendation: MealRecommendation } & RecommendationError>(
    `/api/slots/${SLOT}/recommendation`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return status === 200
    ? { status, body: body.recommendation }
    : { status, body: undefined as unknown as MealRecommendation, error: body };
}

/** 让 fake 像真模型那样「从池中选」：确定性、结构合法（与 E2E 服务端注入的是同一个函数） */
function scriptPoolSelection(): void {
  harness.llm.setCompletion((request) => pickPoolSelection(request.prompt) ?? '{"dishes":[]}');
}

function promptOf(callIndex = 0): string {
  const call = harness.llm.completionCalls[callIndex];
  if (!call) throw new Error(`没有第 ${callIndex} 次 completion 调用`);
  return call.request.prompt;
}

/** 直接往事件流里塞一餐（模拟「最近吃过」；append-only 的库只能插不能改） */
function seedMeal(date: string, recipeIds: string[]): void {
  const [slotDate, meal] = date.split(':') as [string, 'lunch' | 'dinner'];
  harness.db
    .prepare(
      `INSERT INTO meal_events (slot_id, slot_date, meal, type, source, occurred_at)
       VALUES (?, ?, ?, 'decide', 'manual', ?)`,
    )
    .run(date, slotDate, meal, `${slotDate}T04:00:00.000Z`);
  const seq = Number((harness.db.prepare('SELECT last_insert_rowid() AS seq').get() as { seq: number }).seq);
  const insert = harness.db.prepare(
    'INSERT INTO meal_event_dishes (seq, position, recipe_id, keep_leftover) VALUES (?, ?, ?, 0)',
  );
  recipeIds.forEach((recipeId, index) => insert.run(seq, index, recipeId));
}

describe('规则引擎：忌口硬过滤与时令检索', () => {
  it('小宝忌贝类与虾：蚝油(含贝类)与虾类菜不进候选池，prompt 里也看不到', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { status, body } = await recommend({ diners: ['xiaobao'] });
    expect(status).toBe(200);

    const prompt = promptOf();
    expect(prompt).not.toContain('白灼虾');
    expect(prompt).not.toContain('蚝油生菜');
    // 她爱吃的玉米胡萝卜排骨汤没有被硬过滤掉（软加分不等于保证入选）
    expect(prompt).toContain('玉米胡萝卜排骨汤');
    expect(body.dishes.length).toBeGreaterThan(0);
  });

  it('隐性忌口经「含」指针展开：大宝忌辣 → 豆瓣酱做的麻婆豆腐也出局', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    await recommend({ diners: ['dabao'] });
    expect(promptOf()).not.toContain('麻婆豆腐');

    // 反向对照：不忌辣的人看得到它——否则上面那条断言可能因为别的原因成立
    harness.llm.clearCalls();
    await recommend({ diners: ['mom'] });
    expect(promptOf()).toContain('麻婆豆腐');
  });

  it('荤/素/汤位分组进池，每位家庭池最多 8 道', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    await recommend();
    const pool = parsePromptPool(promptOf());
    const count = (position: 'meat' | 'veg' | 'soup'): number =>
      pool.filter((entry) =>
        position === 'soup' ? entry.kind.startsWith('soup') : entry.kind === position,
      ).length;

    expect(pool.length).toBeGreaterThan(0);
    expect(count('meat')).toBeLessThanOrEqual(8);
    expect(count('veg')).toBeLessThanOrEqual(8);
    expect(count('soup')).toBeLessThanOrEqual(8);
  });

  it('外部池补位：荤位家庭池不足 3 道时用草稿菜补齐，来源标「没做过」', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    // 家庭荤位共 8 道（用不忌虾的名单，否则白灼虾本来就被硬过滤）；把 6 道塞进近 7 天窗口
    // → 荤位家庭池只剩 2 道 → 需要 1 道外部补位
    seedMeal('2025-05-30:lunch', [
      'hongshaopaigu',
      'kelejichi',
      'qingzhengluyu',
      'tudouniuniu',
      'tangculiji',
      'chongcaohuazhengji',
    ]);

    const diners = ['mom', 'dad'];
    await recommend({ diners });
    const pool = parsePromptPool(promptOf());
    const meatInPool = pool.filter((entry) => entry.kind === 'meat');
    const external = meatInPool.filter((entry) => entry.origin === 'external');

    expect(meatInPool).toHaveLength(3);
    expect(external).toHaveLength(1);
    // 补位菜来自外部菜谱池（草稿态），且带 0 次的「没做过」来源标记
    expect(['huiguorou', 'fanqieniunan', 'gongbaojiding']).toContain(external[0]!.id);
    expect(promptOf()).toContain('外部（没做过）');

    // 补位菜被选中时，响应里带 origin=external（界面据此显示「没做过」）。
    // 这里显式选它（而不是靠池子顺序碰上）：池子里家庭菜排在前面，
    // 「LLM 优先选做过的」才是常态——本用例要证明的是补位菜可选、且标得出来。
    const paddingId = external[0]!.id;
    harness.llm.setCompletion((request) => {
      const structure = parsePromptStructure(request.prompt)!;
      const position = (kind: string): 'meat' | 'veg' | 'soup' =>
        kind === 'meat' ? 'meat' : kind === 'veg' ? 'veg' : 'soup';
      const want: Record<'meat' | 'veg' | 'soup', number> = { ...structure.need };
      const taken: Record<'meat' | 'veg' | 'soup', number> = { meat: 1, veg: 0, soup: 0 };
      const chosen = [paddingId];
      for (const entry of parsePromptPool(request.prompt)) {
        const slot = position(entry.kind);
        if (entry.id === paddingId || taken[slot] >= want[slot]) continue;
        taken[slot] += 1;
        chosen.push(entry.id);
      }
      return JSON.stringify({ dishes: chosen.map((recipeId) => ({ recipeId, reason: `${recipeId} 一句话` })) });
    });

    const second = await recommend({ diners });
    const externalDish = second.body.dishes.find((dish) => dish.recipeId === paddingId);
    expect(externalDish?.origin).toBe('external');
    expect(externalDish?.reason).toBeTruthy();
  });

  it('同菜 7 天硬排除：窗口内做过的菜不进池；近 7 天已吃另有一段进 prompt 作软避让', async () => {
    harness = createTestHarness();
    scriptPoolSelection();
    seedMeal('2025-05-30:lunch', ['hongshaopaigu']);

    await recommend();
    const prompt = promptOf();
    expect(parsePromptPool(prompt).map((entry) => entry.id)).not.toContain('hongshaopaigu');
    // 但「近 7 天已吃」这一段要告诉 LLM 它做过（软避让主料）
    expect(prompt).toContain('【近 7 天已吃】');
    expect(prompt).toContain('红烧排骨');
  });

  it('近 7 天窗口外的菜可以重新进池（排除会到期）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();
    seedMeal('2025-05-20:lunch', ['hongshaopaigu']);

    await recommend();
    expect(promptOf()).toContain('红烧排骨');
  });

  it('时令是排序不是过滤：6 月的夏天菜排冬天菜前面，没录时令的菜照留在池子里', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    await recommend(); // 6/1 晚餐 → 6 月
    const meat = parsePromptPool(promptOf())
      .filter((entry) => entry.kind === 'meat')
      .map((entry) => entry.id);

    // 菜谱自己标了适季月份（白灼虾 5–10 月）
    expect(meat.indexOf('baizhuoxia')).toBeLessThan(meat.indexOf('qingzhengluyu'));
    // 食材级时令也参与排序（黄焖鸡有青椒，6–9 月）
    expect(meat.indexOf('huangmenji')).toBeLessThan(meat.indexOf('hongshaopaigu'));
    // 「没录时令 = 四季有售」的口径：没标的菜仍然在池子里，只是排在后面
    expect(meat).toContain('qingzhengluyu');
  });
});

describe('家规结构（总纲 §2.2 的 M1 公式）', () => {
  it('基线 2 荤 1 素 1 汤，每多一位成人多一道荤菜；小孩不改变道数', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const all = await recommend();
    expect(all.body.structure).toEqual({ adults: 2, children: 2, meat: 2, veg: 1, soup: 1 });

    harness.llm.clearCalls();
    const oneAdult = await recommend({ diners: ['mom', 'xiaobao'] });
    expect(oneAdult.body.structure).toEqual({ adults: 1, children: 1, meat: 1, veg: 1, soup: 1 });
  });

  it('全小孩时大人数如实报 0（不能为了凑道数把「大人 0、小孩 2」写成大人 1）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const kidsOnly = await recommend({ diners: ['dabao', 'xiaobao'] });
    // 大人数是个事实，不是配额：写进 prompt 的用餐者段与结构段必须同一个值
    expect(kidsOnly.body.structure).toMatchObject({ adults: 0, children: 2 });
    // 道数另算：没人算大人也至少配一道荤（不然一份菜单是空的）
    expect(kidsOnly.body.structure.meat).toBeGreaterThanOrEqual(1);
  });

  it('结构写进 prompt 的机器可读段落，且响应里的菜品数量与它一致', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { body } = await recommend();
    const block = parsePromptStructure(promptOf())!;
    expect(block.need).toEqual({
      meat: body.structure.meat,
      veg: body.structure.veg,
      soup: body.structure.soup,
    });
    expect(body.dishes).toHaveLength(block.total);
    expect(body.dishes.filter((dish) => dish.kind === 'meat')).toHaveLength(body.structure.meat);
    expect(body.dishes.filter((dish) => dish.kind === 'veg')).toHaveLength(body.structure.veg);
    expect(body.dishes.filter((dish) => dish.kind.startsWith('soup'))).toHaveLength(body.structure.soup);
  });
});

describe('降级链（spec S7）', () => {
  it('第一次网络挂 → 重试成功：不降级，只调用 2 次，失败原因进 notes', async () => {
    harness = createTestHarness();
    scriptPoolSelection();
    harness.llm.queueCompletion(new Error('模拟网络超时'));

    const { body } = await recommend();
    expect(body.llm.format).toBe('json_schema');
    expect(body.llm.degraded).toBe(false);
    expect(harness.llm.completionCalls).toHaveLength(2);
    expect(body.notes.join('')).toContain('模拟网络超时');
  });

  it('strict 档两次都不合法 → 降级到 json_object 档完成，format 可观测', async () => {
    harness = createTestHarness();
    // 按档给值：strict 档返回自由文本（本机代理端点不支持 strict 时的真实行为）
    harness.llm.setCompletion((request) =>
      request.responseFormat === 'json_object'
        ? (pickPoolSelection(request.prompt) ?? '{"dishes":[]}')
        : '```\n这道菜很好，我推荐番茄炒蛋。\n```',
    );

    const { body } = await recommend();
    expect(harness.llm.completionCalls.map((call) => call.request.responseFormat)).toEqual([
      'json_schema',
      'json_schema',
      'json_object',
    ]);
    expect(body.llm.format).toBe('json_object');
    expect(body.llm.degraded).toBe(true);
    expect(body.notes.join('')).toContain('严格 schema 档第 1 次');
    expect(body.notes.join('')).toContain('端点未支持严格 schema');
  });

  it('形状合法但结构不符 → 判失败并重试，不把不合格的菜单端上桌', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'fanqiechaodan', reason: '一道素菜' }] }));

    const { body } = await recommend();
    expect(body.llm.format).toBe('rules_only');
    expect(body.notes.join('')).toContain('结构不符');
    expect(body.dishes).toHaveLength(body.structure.meat + body.structure.veg + body.structure.soup);
  });

  it('两档四次都失败 → 简化推荐：规则拼餐、degraded、format=rules_only、理由为 null', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点彻底不可用'));

    const { status, body } = await recommend();
    expect(status).toBe(200);
    expect(harness.llm.completionCalls).toHaveLength(4); // 两档各重试 1 次
    expect(body.llm.format).toBe('rules_only');
    expect(body.llm.degraded).toBe(true);
    expect(body.llm.model).toBe('fake-llm');
    expect(body.notes.join('')).toMatch(/简化推荐/);
    // 规则拼出来的结构还是满的，且不编造理由
    expect(body.dishes).toHaveLength(body.structure.meat + body.structure.veg + body.structure.soup);
    expect(body.dishes.every((dish) => dish.reason === null)).toBe(true);
    // 拼的是规则序：6 月的时令菜排在前面（黄焖鸡用 6–9 月的青椒、番茄炒蛋用 6 月的番茄）
    const names = body.dishes.map((dish) => dish.name);
    expect(names).toContain('黄焖鸡');
    expect(names).toContain('番茄炒蛋');
    // 小宝忌虾：白灼虾连池子都进不去（硬过滤在排序之前）
    expect(names).not.toContain('白灼虾');
  });

  it('模型给出池外的菜（幻觉）→ 判失败并降级；幻觉永不落进推荐', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion(JSON.stringify({ dishes: [{ recipeId: 'mianfeidewucan', reason: '编的' }] }));

    const { body } = await recommend();
    expect(body.llm.format).toBe('rules_only');
    expect(body.notes.join('')).toContain('候选池里没有的菜');
    expect(body.dishes.map((dish) => dish.recipeId)).not.toContain('mianfeidewucan');
  });

  it('同一道菜选两次 → 判失败（去重是结构的一部分）', async () => {
    harness = createTestHarness();
    harness.llm.setCompletion(
      JSON.stringify({
        dishes: [
          { recipeId: 'fanqiechaodan', reason: 'a' },
          { recipeId: 'fanqiechaodan', reason: 'b' },
        ],
      }),
    );

    const { body } = await recommend();
    expect(body.notes.join('')).toContain('选了两次');
  });

  it('简化推荐也不落库：它只是把编辑器预填好，定不定由家人决定', async () => {
    harness = createTestHarness();
    harness.llm.setCompletionError(new Error('端点不可用'));

    await recommend();
    const { body } = await harness.json<{ slot: SlotWithPortion }>(`/api/slots/${SLOT}`);
    expect(body.slot.status).toBe('undecided');
  });
});

describe('推荐落地产出的形状', () => {
  it('推荐不落库：打完推荐餐槽仍是未定', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    await recommend();
    const { body } = await harness.json<{ slot: SlotWithPortion }>(`/api/slots/${SLOT}`);
    expect(body.slot.status).toBe('undecided');
    expect(body.slot.menu).toBeNull();
  });

  it('响应带用餐者快照、结构、每道菜的理由与来源，以及 LLM 元数据', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { body } = await recommend();
    expect(body.slotId).toBe(SLOT);
    expect(body.diners.map((diner) => diner.memberId)).toEqual(['mom', 'dad', 'dabao', 'xiaobao']);
    expect(body.llm.promptVersion).toMatch(/^\d{4}-\d{2}/);
    expect(body.llm.latencyMs).toBeGreaterThanOrEqual(0);
    for (const dish of body.dishes) {
      expect(dish.reason, dish.name).toBeTruthy();
      expect<RecipeOrigin>(dish.origin).toMatch(/^(family|external)$/);
    }
  });

  it('这餐过了截止时刻 → 400 slot_passed（不给已经上桌的饭做推荐）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { status, error } = await recommendTo('2025-05-30:dinner', {});
    expect(status).toBe(400);
    expect(error?.error).toBe('slot_passed');
  });

  it('餐槽 id 非法 → 400；名单里有人不存在 → 400 unknown_member', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const bad = await recommendTo('2025-06-01:brunch', {});
    expect(bad.status).toBe(400);
    expect(bad.error?.error).toBe('invalid_slot_id');

    const unknown = await recommend({ diners: ['nobody'] });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.error).toBe('unknown_member');
  });

  it('池子被忌口与去重清空 → 409 no_candidates（可行动的错，不是空菜单）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const all = harness.db.prepare("SELECT id FROM recipes WHERE status IN ('active', 'draft')").all() as {
      id: string;
    }[];
    seedMeal(
      '2025-05-31:lunch',
      all.map((recipe) => recipe.id),
    );

    const { status, error } = await recommend();
    expect(status).toBe(409);
    expect(error?.error).toBe('no_candidates');
  });
});

async function recommendTo(
  slotId: string,
  payload: unknown,
): Promise<{ status: number; body?: unknown; error?: RecommendationError }> {
  const { status, body } = await harness.json<Record<string, unknown>>(`/api/slots/${slotId}/recommendation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return status === 200 ? { status, body } : { status, error: body as unknown as RecommendationError };
}

describe('接受推荐（一键成菜单）', () => {
  it('推荐 → 一键接受：菜单落库、事件 source=recommendation、LLM 元数据进留痕', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { body: recommendation } = await recommend();
    const accepted = await harness.json<{ slot: SlotWithPortion }>(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diners: recommendation.diners.map((diner) => diner.memberId),
        dishes: recommendation.dishes.map((dish) => ({ recipeId: dish.recipeId })),
        source: 'recommendation',
        llm: {
          model: recommendation.llm.model,
          promptVersion: recommendation.llm.promptVersion,
          latencyMs: recommendation.llm.latencyMs,
          degraded: recommendation.llm.degraded,
        },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.slot.status).toBe('decided');
    expect(accepted.body.slot.menu?.dishes.map((dish) => dish.recipeId)).toEqual(
      recommendation.dishes.map((dish) => dish.recipeId),
    );

    // 留痕：来源是 recommendation，且带全套 LLM 元数据（模型名/prompt 版本/耗时/是否降级）
    const { body: slot } = await harness.json<{ history: MealEvent[] }>(`/api/slots/${SLOT}`);
    const last = slot.history[slot.history.length - 1]!;
    expect(last.source).toBe('recommendation');
    expect(last.llm).toEqual({
      model: recommendation.llm.model,
      promptVersion: recommendation.llm.promptVersion,
      latencyMs: recommendation.llm.latencyMs,
      degraded: recommendation.llm.degraded,
    });
  });

  it('已定的一餐再接受一份新推荐 → 记「换一整套」（replace_set，ADR-0007 的词汇）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    // 先手动定一餐
    await harness.json(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });

    const { body: recommendation } = await recommend();
    await harness.json(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diners: recommendation.diners.map((diner) => diner.memberId),
        dishes: recommendation.dishes.map((dish) => ({ recipeId: dish.recipeId })),
        source: 'recommendation',
      }),
    });

    // 换成另一套菜（不是同一套的重复提交）；已定时接受推荐 = 把这一餐整套换掉
    const { body } = await harness.json<{ history: MealEvent[] }>(`/api/slots/${SLOT}`);
    expect(body.history.map((event) => event.type)).toEqual(['decide', 'replace_set']);
  });

  it('同一份推荐重复提交不追事件（内容与来源都相同时不写历史）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { body: recommendation } = await recommend();
    const booking = {
      diners: recommendation.diners.map((diner) => diner.memberId),
      dishes: recommendation.dishes.map((dish) => ({ recipeId: dish.recipeId })),
      source: 'recommendation' as const,
    };
    const put = (): Promise<unknown> =>
      harness.json(`/api/slots/${SLOT}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(booking),
      });

    await put();
    await put();
    const { body } = await harness.json<{ history: MealEvent[] }>(`/api/slots/${SLOT}`);
    expect(body.history).toHaveLength(1);
  });

  it('手动定餐带上 LLM 元数据 → 400：留痕里不能有解释不了的记录', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { status, body } = await harness.json<RecommendationError>(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diners: ['mom'],
        dishes: [{ recipeId: 'fanqiechaodan' }],
        llm: { model: 'x', promptVersion: 'v', latencyMs: 1, degraded: false },
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toBe('llm_meta_without_recommendation');
  });

  it('手动定餐的留痕不带 LLM 元数据（llm 为 null、source 为 manual）', async () => {
    harness = createTestHarness();

    await harness.json(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diners: ['mom'], dishes: [{ recipeId: 'fanqiechaodan' }] }),
    });

    const { body } = await harness.json<{ history: MealEvent[] }>(`/api/slots/${SLOT}`);
    expect(body.history.every((event) => event.llm === null)).toBe(true);
    expect(body.history.every((event) => event.source === 'manual')).toBe(true);
  });

  it('接受推荐后主界面能看到这一餐（推荐只是编辑器的预填）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const { body: recommendation } = await recommend();
    await harness.json(`/api/slots/${SLOT}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        diners: recommendation.diners.map((diner) => diner.memberId),
        dishes: recommendation.dishes.map((dish) => ({ recipeId: dish.recipeId })),
        source: 'recommendation',
      }),
    });

    const { body } = await harness.json<SlotsResponse>('/api/slots?days=2');
    const slot = body.slots.find((item) => item.id === SLOT)!;
    expect(slot.status).toBe('decided');
    expect(slot.portion?.dishes).toHaveLength(recommendation.dishes.length);
  });
});

describe('推荐接口的入参', () => {
  it('用餐者缺省 = 全员；显式给空数组 → 400', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    const all = await recommend();
    expect(all.body.diners).toHaveLength(4);

    const empty = await recommend({ diners: [] });
    expect(empty.status).toBe(400);
  });

  it('连续两次推荐各自现算（不做缓存菜单）', async () => {
    harness = createTestHarness();
    scriptPoolSelection();

    await recommend();
    await recommend();
    expect(harness.llm.completionCalls).toHaveLength(2);
  });
});
