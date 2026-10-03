import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake.js';
import { sectionAfter } from './prompt.js';
import {
  buildNutritionPrompt,
  estimateNutrition,
  estimatedNutritionSource,
  isEstimatedNutritionSource,
  NUTRITION_MARK,
  NUTRITION_NO_ESTIMATE_PROBE,
  NUTRITION_REFERENCE_MARK,
  pickNutritionEstimate,
  resolveNutritionEstimate,
  type NutritionReference,
} from './nutrition-estimate-schema.js';

/**
 * 估算营养（CONTEXT「估算营养」；ADR-0013；issue #38）在 **LLM 这一侧**的形状与校验。
 *
 * 库那一侧（落库、覆盖保护、读数口径）在 `api/ingredient-nutrition.test.ts` 与 `api/nutrition.test.ts`；
 * 这里只管三件事：
 *   * prompt 里那两段机器可读标记（【待估算营养的食材】/【可参照的成分表条目】）是接口不是装饰
 *     ——fake 与测试靠它从 prompt 里读回输入（与其余几条 LLM 路径同一纪律）；
 *   * **参照条目必须落在池子里**：模型可以给数字（ADR-0013 允许估算），但「参照的是哪条成分表条目」
 *     要能回查——给一个池子外的食物名等于把幻觉写进 source，那一行的出处就成了假证据；
 *   * 两种空必须分得开：`degraded: true` = AI 这次用不了（调用失败/产出不可信），
 *     `estimate: null` = AI 看过了、估不出来（ADR-0013 与 ADR-0012 同一条「降级必须可区分」）。
 */

/** 一条成分表读数（池子条目）：数字是 012 里「酱油(均值)」的真实读数，测试里当已知量用 */
function reference(overrides: Partial<NutritionReference> = {}): NutritionReference {
  return {
    ingredientId: 'light_soy_sauce',
    name: '酱油(均值)',
    energyKcal: 64.3,
    proteinG: 5.6,
    fatG: 0.1,
    carbG: 10.1,
    ...overrides,
  };
}

function references(...items: NutritionReference[]): NutritionReference[] {
  return items.length > 0 ? items : [reference()];
}

describe('prompt 的形状（机器可读标记是接口）', () => {
  it('两条标记行各占一行，段体分别是名称与带数字的紧凑 JSON（fake 从这里读回输入）', () => {
    const prompt = buildNutritionPrompt({ name: '38-蚝油', references: references() });
    const lines = prompt.split('\n');
    expect(lines).toContain(NUTRITION_MARK);
    expect(lines).toContain(NUTRITION_REFERENCE_MARK);

    // 读回走 prompt.ts 的 `sectionAfter`（与推荐/转正/导入/「含」提议同一个解析器）
    expect(sectionAfter(prompt, NUTRITION_MARK)).toBe('38-蚝油');
    const block = JSON.parse(sectionAfter(prompt, NUTRITION_REFERENCE_MARK)!) as NutritionReference[];
    // 池子里必须有**数字**：估算要以最接近的那条为参照，只给名字等于让模型凭空猜
    expect(block).toEqual([
      {
        id: 'light_soy_sauce',
        name: '酱油(均值)',
        energyKcal: 64.3,
        proteinG: 5.6,
        fatG: 0.1,
        carbG: 10.1,
      },
    ]);
  });
});

describe('resolveNutritionEstimate：参照条目必须落在池子里', () => {
  it('池内的名字原样对上：四项照收，reference 用池内条目（id + 规范名）', () => {
    const estimate = resolveNutritionEstimate(
      { energyKcal: 70, proteinG: 6, fatG: 0.2, carbG: 11, reference: '酱油(均值)' },
      references(),
    );
    expect(estimate).toEqual({
      energyKcal: 70,
      proteinG: 6,
      fatG: 0.2,
      carbG: 11,
      reference: { ingredientId: 'light_soy_sauce', name: '酱油(均值)' },
    });
  });

  it('参照条目在池子外 → 整条不可用（undefined），不把幻觉的名字写进出处', () => {
    expect(
      resolveNutritionEstimate(
        { energyKcal: 70, proteinG: 6, fatG: 0.2, carbG: 11, reference: '成分表里没有这个食物' },
        references(),
      ),
    ).toBeUndefined();
  });

  it('名字两边的空白容忍（模型抄名字时常带空格）', () => {
    const estimate = resolveNutritionEstimate(
      { energyKcal: 70, proteinG: 6, fatG: 0.2, carbG: 11, reference: ' 酱油(均值) ' },
      references(),
    );
    expect(estimate?.reference.ingredientId).toBe('light_soy_sauce');
  });

  it('负数 / 非有限值不算数（形状层已经拦了，这里再确认一次）', () => {
    const base = { energyKcal: 70, proteinG: 6, fatG: 0.2, carbG: 11, reference: '酱油(均值)' };
    expect(resolveNutritionEstimate({ ...base, energyKcal: -1 }, references())).toBeUndefined();
    expect(resolveNutritionEstimate({ ...base, proteinG: Number.NaN }, references())).toBeUndefined();
  });
});

describe('estimateNutrition：json_object + 失败重试（与「含」提议同一条纪律）', () => {
  it('成功：四项 + 参照条目，degraded=false', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion(({ prompt }) => pickNutritionEstimate(prompt)!);

    const outcome = await estimateNutrition(llm, { name: '38-蚝油', references: references() });
    expect(outcome.estimate).toEqual({
      energyKcal: 64.3,
      proteinG: 5.6,
      fatG: 0.1,
      carbG: 10.1,
      reference: { ingredientId: 'light_soy_sauce', name: '酱油(均值)' },
    });
    expect(outcome.degraded).toBe(false);
    expect(outcome.calls).toBe(1);
  });

  it('用 json_object 档、低温（离线路径：同一条食材每次给同一份估算）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"estimate":null}');
    await estimateNutrition(llm, { name: '38-蚝油', references: references() });

    const request = llm.completionCalls.at(-1)!.request;
    expect(request.responseFormat).toBe('json_object');
    expect(request.temperature).toBeLessThanOrEqual(0.3);
  });

  it('AI 看过了、估不出来 → degraded=false + 无估算（与「用不了」分得开）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"estimate":null}');

    const outcome = await estimateNutrition(llm, { name: '38-怪东西', references: references() });
    expect(outcome.estimate).toBeUndefined();
    expect(outcome.degraded).toBe(false);
  });

  it('调用一直失败 → degraded=true + 无估算（降级不是失败，由路由照 200 返回）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletionError(new Error('端点不可达'));

    const outcome = await estimateNutrition(llm, { name: '38-蚝油', references: references() });
    expect(outcome.estimate).toBeUndefined();
    expect(outcome.degraded).toBe(true);
    expect(outcome.calls).toBe(2);
    expect(outcome.notes.join('')).toMatch(/失败/);
  });

  it('参照条目越界（模型编了一个池子外的食物名）→ 产出不可信，重试后降级', async () => {
    const llm = createFakeLlmClient();
    // 编出来的参照名对不上池子：不能采用（否则 source 里的出处是假的）
    llm.setCompletion('{"estimate":{"energyKcal":1,"proteinG":1,"fatG":1,"carbG":1,"reference":"字典外的食物"}}');

    const outcome = await estimateNutrition(llm, { name: '38-蚝油', references: references() });
    expect(outcome.estimate).toBeUndefined();
    expect(outcome.degraded).toBe(true);
    expect(outcome.notes.join('')).toMatch(/参照/);
  });

  it('形状不合（缺项 / 给字符串）→ 重试后降级，不抛错', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"estimate":{"energyKcal":"很多"}}');

    const outcome = await estimateNutrition(llm, { name: '38-蚝油', references: references() });
    expect(outcome.degraded).toBe(true);
    expect(outcome.estimate).toBeUndefined();
  });

  it('池子空就不必问（没有可参照的成分表条目，答案与 AI 健康状况无关）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion('{"estimate":null}');

    const outcome = await estimateNutrition(llm, { name: '38-蚝油', references: [] });
    expect(outcome.estimate).toBeUndefined();
    expect(outcome.degraded).toBe(false);
    expect(outcome.calls).toBe(0);
    expect(llm.completionCalls).toHaveLength(0);
    expect(outcome.notes.join('')).toMatch(/没有可参照/);
  });
});

describe('estimatedNutritionSource：source 自证是估算（ADR-0013 决定一）', () => {
  it('带模型标识与参照的成分表条目，且能被固定前缀认出来', () => {
    const source = estimatedNutritionSource('deepseek-v4.1-flash', { ingredientId: 'light_soy_sauce', name: '酱油(均值)' });
    expect(source).toContain('LLM 估算');
    expect(source).toContain('deepseek-v4.1-flash');
    expect(source).toContain('酱油(均值)');
    // 判定「是不是估算行」靠固定前缀，**不靠新列**（ADR-0013 决定一）
    expect(isEstimatedNutritionSource(source)).toBe(true);
  });

  it('成分表读数与定义性零点都不算估算行（012 的既有 source 一个都不许被误判）', () => {
    expect(
      isEstimatedNutritionSource(
        '食物成分表第 6 版标准版（中国营养学会 / 中国疾控中心营养与健康所「食物营养成分查询平台」nlc.chinanutri.cn/fq/）食物名「酱油(均值)」：269 kJ/蛋白质 5.6 g/脂肪 0.1 g/碳水 10.1 g，每 100 g 可食部；kcal = kJ ÷ 4.184',
      ),
    ).toBe(false);
    expect(isEstimatedNutritionSource('水（饮用水与开水同一条目）：能量 0 kcal …')).toBe(false);
  });
});

describe('pickNutritionEstimate：确定性 fake 的语义（E2E 用）', () => {
  it('按名字挑参照条目，并照抄它的四项读数（数字可复算）', () => {
    const prompt = buildNutritionPrompt({
      name: '38-蚝油',
      references: references(reference(), reference({ ingredientId: 'pork_ribs', name: '猪大排', energyKcal: 261.7, proteinG: 18.3, fatG: 20.4, carbG: 1.7 })),
    });
    const parsed = JSON.parse(pickNutritionEstimate(prompt)!) as {
      estimate: { energyKcal: number; reference: string };
    };
    expect(parsed.estimate.reference).toBe('酱油(均值)');
    expect(parsed.estimate.energyKcal).toBe(64.3);
  });

  it('认不出的名字回落池子第一条（确定性，不随机）', () => {
    const prompt = buildNutritionPrompt({
      name: '38-说不清是什么的东西',
      references: references(reference({ ingredientId: 'egg', name: '蛋（鸡蛋，均值)', energyKcal: 143.2 })),
    });
    const parsed = JSON.parse(pickNutritionEstimate(prompt)!) as { estimate: { reference: string } };
    expect(parsed.estimate.reference).toBe('蛋（鸡蛋，均值)');
  });

  it('名字带探针词「估不出」时回 {"estimate":null}（页面层验「AI 估不出来」用）', () => {
    const prompt = buildNutritionPrompt({ name: `38-${NUTRITION_NO_ESTIMATE_PROBE}的东西`, references: references() });
    expect(JSON.parse(pickNutritionEstimate(prompt)!)).toEqual({ estimate: null });
  });

  it('prompt 里没有标记段就返回 undefined（fake 回落到别的路，不硬猜）', () => {
    expect(pickNutritionEstimate('随便一段文字')).toBeUndefined();
    expect(pickNutritionEstimate(`${NUTRITION_REFERENCE_MARK}\n[{"id":"a","name":"酱油"}]`)).toBeUndefined();
  });

  it('fake 的输出必须过得了真校验（否则 E2E 验的不是真实路径）', () => {
    const pool = references();
    const prompt = buildNutritionPrompt({ name: '38-蚝油', references: pool });
    const parsed = JSON.parse(pickNutritionEstimate(prompt)!) as { estimate: unknown };
    const raw = (parsed.estimate as { energyKcal: number; proteinG: number; fatG: number; carbG: number; reference: string });
    expect(resolveNutritionEstimate(raw, pool)?.reference.name).toBe('酱油(均值)');
  });
});
