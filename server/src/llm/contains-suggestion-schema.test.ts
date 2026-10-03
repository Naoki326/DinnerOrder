import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake.js';
import { sectionAfter } from './prompt.js';
import {
  buildContainsPrompt,
  CONTAINS_MARK,
  CONTAINS_OUT_OF_POOL_PROBE,
  CONTAINS_POOL_MARK,
  pickContainsSuggestion,
  resolveContainsTargets,
  suggestContains,
  type ContainsSuggestionRequest,
} from './contains-suggestion-schema.js';
import type { IngredientRef } from '../wire-types.js';

/**
 * 「含」提议（CONTEXT「『含』提议」；ADR-0012「决定六」）在 **LLM 这一侧**的形状与校验。
 * 库那一侧的行为在 `api/ingredients.test.ts`；这里只管「提示词给了什么、出参怎么被筛」：
 *   * prompt 里那两段机器可读标记（【待建议的复合调料】/【可挂的食材池】）是接口，不是装饰
 *     ——fake 与测试靠它从 prompt 里读回输入（与其余几条 LLM 路径同一纪律）；
 *   * **越界丢该条**（而不是整条失败，也不是照单全收）是本模块与推荐/候选那两条路的关键差别；
 *   * 两种空必须分得开：`degraded: false` + 空 = 「AI 看过了、没有建议」，
 *     `degraded: true` + 空 = 「AI 用不了」（ADR-0012「降级必须可区分」）。
 */

function pool(...names: string[]): IngredientRef[] {
  return names.map((name) => ({ ingredientId: `id-${name}`, name }));
}

function request(overrides: Partial<ContainsSuggestionRequest> = {}): ContainsSuggestionRequest {
  return { name: '蚝油', pool: pool('贝类', '辣椒', '大豆'), ...overrides };
}

describe('prompt 的形状（机器可读标记是接口）', () => {
  it('两条标记行各占一行，段体分别是名称与紧凑 JSON（fake 从这里读回输入）', () => {
    const prompt = buildContainsPrompt(request());
    const lines = prompt.split('\n');
    expect(lines).toContain(CONTAINS_MARK);
    expect(lines).toContain(CONTAINS_POOL_MARK);

    // 读回走 prompt.ts 的 `sectionAfter`（与推荐/转正/导入同一个解析器）——漂移会让 fake 读错
    expect(sectionAfter(prompt, CONTAINS_MARK)).toBe('蚝油');
    const block = JSON.parse(sectionAfter(prompt, CONTAINS_POOL_MARK)!) as { id: string; name: string }[];
    expect(block).toEqual([
      { id: 'id-贝类', name: '贝类' },
      { id: 'id-辣椒', name: '辣椒' },
      { id: 'id-大豆', name: '大豆' },
    ]);
  });
});

describe('resolveContainsTargets：越界丢该条', () => {
  it('字典外（池外）的名字被丢掉，同批池内的照收', () => {
    const targets = resolveContainsTargets(
      [{ name: '贝类' }, { name: '字典里没有这个' }, { name: '辣椒' }],
      pool('贝类', '辣椒'),
    );
    expect(targets).toEqual([
      { ingredientId: 'id-贝类', name: '贝类' },
      { ingredientId: 'id-辣椒', name: '辣椒' },
    ]);
  });

  it('按 id 也能对上（模型抄 id 时算数）；对不上的 id 与名字一起丢', () => {
    const targets = resolveContainsTargets(
      [{ name: '随便写的', id: 'id-贝类' }, { name: '贝类', id: 'ghost' }],
      pool('贝类'),
    );
    // 第一条：名字没对上但 id 对上了 → 用池内条目；第二条：id 对不上，名字对上了 → 也算
    expect(targets).toEqual([{ ingredientId: 'id-贝类', name: '贝类' }]);
  });

  it('同一条给两次只留一次（保序）', () => {
    expect(resolveContainsTargets([{ name: '贝类' }, { name: '贝类' }], pool('贝类', '辣椒'))).toEqual([
      { ingredientId: 'id-贝类', name: '贝类' },
    ]);
  });

  it('全是越界 → 空数组（不是报错）', () => {
    expect(resolveContainsTargets([{ name: '甲' }, { name: '乙' }], pool('贝类'))).toEqual([]);
  });

  it('空输入得当：空数组进、空数组出', () => {
    expect(resolveContainsTargets([], pool('贝类'))).toEqual([]);
  });
});

describe('suggestContains：json_object + 失败重试（与转正同一条纪律）', () => {
  it('成功：返回池内目标，degraded=false', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion(({ prompt }) => pickContainsSuggestion(prompt)!);

    const outcome = await suggestContains(llm, request());
    expect(outcome.targets).toEqual([{ ingredientId: 'id-贝类', name: '贝类' }]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.calls).toBe(1);
  });

  it('用 json_object 档、低温（离线路径：同一条调料每次给同一批候选）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"targets":[]}');
    await suggestContains(llm, request());

    const call = llm.completionCalls[0]!;
    expect(call.request.responseFormat).toBe('json_object');
    expect(call.request.temperature).toBe(0.2);
  });

  it('畸形 JSON / 非数组 JSON 不炸：重试一次仍不合 → 降级（degraded=true + 空）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('这不是 JSON');
    const broken = await suggestContains(llm, request());
    expect(broken.targets).toEqual([]);
    expect(broken.degraded).toBe(true);
    expect(broken.calls).toBe(2);
    expect(broken.notes.join('')).toMatch(/形状不合/);

    // `targets` 给了字符串（不是数组）同样算形状不合，而不是把字符串当数组遍历
    const llm2 = createFakeLlmClient();
    llm2.setCompletion(JSON.stringify({ targets: '贝类' }));
    const notArray = await suggestContains(llm2, request());
    expect(notArray.degraded).toBe(true);
    expect(notArray.targets).toEqual([]);

    // 连 JSON 都不是对象（数组/数字/字符串）也不炸
    for (const text of ['[]', '3', '"贝类"', 'null']) {
      const llm3 = createFakeLlmClient();
      llm3.setCompletion(text);
      const outcome = await suggestContains(llm3, request());
      expect(outcome.degraded).toBe(true);
      expect(outcome.targets).toEqual([]);
    }
  });

  it('第一次形状不合、第二次对了 → 成功（重试是这条路的一部分）', async () => {
    const llm = createFakeLlmClient();
    llm.queueCompletion('不是 JSON');
    llm.setCompletion(({ prompt }) => pickContainsSuggestion(prompt)!);

    const outcome = await suggestContains(llm, request());
    expect(outcome.degraded).toBe(false);
    expect(outcome.targets).toHaveLength(1);
    expect(outcome.calls).toBe(2);
  });

  it('LLM 抛错（端点不可达）→ 降级：degraded=true + 空数组，不抛', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletionError(new Error('端点不可达'));

    const outcome = await suggestContains(llm, request());
    expect(outcome.targets).toEqual([]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.calls).toBe(2);
    expect(outcome.notes.join('')).toMatch(/端点不可达/);
  });

  it('「AI 看过、没有建议」与「AI 用不了」是两条不同的结果（degraded 分得开）', async () => {
    const empty = createFakeLlmClient();
    empty.setCompletion('{"targets":[]}');
    const noSuggestion = await suggestContains(empty, request());

    const down = createFakeLlmClient();
    down.setCompletionError(new Error('端点不可达'));
    const degraded = await suggestContains(down, request());

    // 两者的 targets 都是空，但 degraded 不同——界面据此说两句不同的话
    expect(noSuggestion.targets).toEqual(degraded.targets);
    expect(noSuggestion.degraded).toBe(false);
    expect(degraded.degraded).toBe(true);
    expect(noSuggestion).not.toEqual(degraded);
  });

  it('池子空就不问 LLM：空结果 + degraded=false（「字典里没有」不是 AI 故障）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"targets":[]}');
    const outcome = await suggestContains(llm, request({ pool: [] }));

    expect(outcome.targets).toEqual([]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.calls).toBe(0);
    expect(llm.completionCalls).toHaveLength(0);
    expect(outcome.notes.join('')).toMatch(/没有可挂的目标/);
  });

  it('全是越界 → degraded=false + 空（不是降级：AI 答了，只是没有池内的）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion(JSON.stringify({ targets: [{ name: '字典里没有这个' }] }));
    const outcome = await suggestContains(llm, request());

    expect(outcome.targets).toEqual([]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.notes.join('')).toMatch(/字典外/);
  });
});

describe('pickContainsSuggestion：确定性 fake 的语义（E2E 用）', () => {
  it('按名字找池内条目：蚝油 → 贝类；认不出的名字 → 空数组', () => {
    const prompt = buildContainsPrompt(request());
    const parsed = JSON.parse(pickContainsSuggestion(prompt)!) as { targets: { name: string }[] };
    expect(parsed.targets.map((item) => item.name)).toEqual(['贝类']);

    // 认不出、且池子里也没有对得上的 → 空数组（「没有建议」的确定性样本）
    const nothing = buildContainsPrompt({ name: '随便一条调料', pool: pool('贝类') });
    expect(JSON.parse(pickContainsSuggestion(nothing)!)).toEqual({ targets: [] });
  });

  it('名字带探针词「越界」时额外吐一个字典外的目标（页面层验「越界被拦下」用）', () => {
    const prompt = buildContainsPrompt({ name: `37-越界蚝油`, pool: pool('贝类') });
    const parsed = JSON.parse(pickContainsSuggestion(prompt)!) as { targets: { name: string }[] };
    expect(parsed.targets.map((item) => item.name)).toEqual(['贝类', CONTAINS_OUT_OF_POOL_PROBE]);
    // fake 的输出必须过得了真校验（否则 E2E 验的就不是真实路径）
    expect(resolveContainsTargets(parsed.targets, pool('贝类'))).toEqual([{ ingredientId: 'id-贝类', name: '贝类' }]);
  });

  it('prompt 里没有标记段就返回 undefined（fake 回落到别的路，不硬猜）', () => {
    expect(pickContainsSuggestion('随便一段文字')).toBeUndefined();
    // 只有池子没有名字段同样不硬猜
    expect(pickContainsSuggestion(`${CONTAINS_POOL_MARK}\n[{"id":"a","name":"贝类"}]`)).toBeUndefined();
  });
});
