import { describe, expect, it } from 'vitest';
import { createFakeLlmClient } from './fake.js';
import { sectionAfter } from './prompt.js';
import {
  buildPromotionPrompt,
  DIFFERENCES_MARK,
  pickPromotionRewrite,
  PROMOTION_MARK,
  PROMOTION_PROMPT_VERSION,
  rewriteRecipe,
  validateRewrite,
  type PromotionRequest,
  type PromotionRewrite,
} from './promotion-schema.js';
import type { Recipe } from '../wire-types.js';

/**
 * 转正改写（总纲 §2.8）在 **LLM 这一侧**的形状与校验。库那一侧的行为在
 * `api/promotion.test.ts`；这里只管「提示词给了什么、出参怎么被筛」：
 *   * prompt 里那两段机器可读标记（【待转正菜谱】/【掌勺者口述差异】）是接口，不是装饰
 *     ——fake 与测试靠它从 prompt 里读回输入（与 `llm/prompt.ts` 同一纪律）；
 *   * `validateRewrite` 的四条硬约束各有真实后果：名字对不上就写不到字典项上、
 *     全 0 会把菜谱改空、待重标项被写成 0 就是把「未定」固化成「没有」、口味/菜系值域封闭
 *     （与迁移 005 的 CHECK 同源）。
 */

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'qingchaodouya',
    name: '清炒豆芽',
    aliases: [],
    kind: 'veg',
    tastes: ['清淡'],
    seasonMonths: [],
    avoidIngredientIds: ['bean_sprouts', 'garlic'],
    effort: 'quick',
    status: 'draft',
    source: 'howtocook',
    cuisine: '家常',
    steps: '豆芽洗净沥干，热锅爆香蒜末，大火快炒 1 分钟，加盐出锅。',
    ingredients: [
      { ingredientId: 'bean_sprouts', name: '豆芽', adultGrams: 160, scaling: 'linear', rawCookedAnchor: null },
      { ingredientId: 'garlic', name: '蒜', adultGrams: 8, scaling: 'fixed', rawCookedAnchor: null },
    ],
    ...overrides,
  };
}

function request(overrides: Partial<PromotionRequest> = {}): PromotionRequest {
  return { recipe: recipe(), differences: '', ...overrides };
}

function raw(overrides: Partial<PromotionRewrite> = {}): PromotionRewrite {
  return {
    kind: 'veg',
    effort: 'quick',
    tastes: ['清淡'],
    ingredients: [
      { name: '豆芽', grams: 160 },
      { name: '蒜', grams: 8 },
    ],
    ...overrides,
  };
}

describe('prompt 的形状（机器可读标记是接口）', () => {
  it('标记行紧后的一行才是内容（读回走 prompt.ts 的 `sectionAfter`，与推荐/换菜同一个解析器）', () => {
    const prompt = buildPromotionPrompt(request({ differences: '多点辣' }));
    // 两条路的解析器是同一份代码：一旦漂移，fake 对某种 prompt 的读法就会与另一条路不同
    expect(sectionAfter(prompt, PROMOTION_MARK)).toBeDefined();
    expect(sectionAfter(prompt, DIFFERENCES_MARK)).toBe('多点辣');
    // 没有标记就不硬猜（与推荐那条路同一语义）
    expect(sectionAfter(prompt, '【不存在的标记】')).toBeUndefined();
  });

  it('待重标项的克数在 prompt 里如实是 0（模型必须给正数，除非掌勺者说了不要它）', () => {
    const pending = request({
      recipe: recipe({
        ingredients: [
          { ingredientId: 'bean_sprouts', name: '豆芽', adultGrams: 160, scaling: 'linear', rawCookedAnchor: null },
          { ingredientId: 'garlic', name: '蒜', adultGrams: 0, scaling: 'fixed', rawCookedAnchor: null },
        ],
      }),
    });
    const block = sectionAfter(buildPromotionPrompt(pending), PROMOTION_MARK)!;
    const parsed = JSON.parse(block) as { ingredients: { name: string; grams: number }[] };
    expect(parsed.ingredients.find((item) => item.name === '蒜')!.grams).toBe(0);
  });

  it('两段标记各占一行，段体是 JSON / 原文（fake 与测试据此读回输入）', () => {
    const prompt = buildPromotionPrompt(request({ differences: '不放蒜' }));
    const lines = prompt.split('\n');
    expect(lines).toContain(PROMOTION_MARK);
    expect(lines).toContain(DIFFERENCES_MARK);

    const recipeLine = lines[lines.indexOf(PROMOTION_MARK) + 1]!;
    const parsed = JSON.parse(recipeLine) as { id: string; ingredients: { name: string; grams: number }[] };
    expect(parsed.id).toBe('qingchaodouya');
    expect(parsed.ingredients).toEqual([
      { name: '豆芽', grams: 160, scaling: 'linear' },
      { name: '蒜', grams: 8, scaling: 'fixed' },
    ]);
    expect(lines[lines.indexOf(DIFFERENCES_MARK) + 1]).toBe('不放蒜');
  });

  it('没口述差异时给一句「照原谱整理」而不是留空（空段会被模型当成没说完的话）', () => {
    const prompt = buildPromotionPrompt(request({ differences: '   ' }));
    expect(prompt).toContain('（掌勺者没说差异');
  });

  it('掌勺者校对过菜系时明确写进 prompt（他的判断优先）', () => {
    const prompt = buildPromotionPrompt(request({ cuisine: '粤' }));
    expect(prompt).toContain('粤');
  });
});

describe('validateRewrite：四条硬约束', () => {
  it('食材名单必须原样覆盖（漏一项 / 多一项 / 重名都拒绝）', () => {
    const missing = validateRewrite(raw({ ingredients: [{ name: '豆芽', grams: 160 }] }), request());
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toMatch(/漏掉/);

    const extra = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 160 }, { name: '蒜', grams: 8 }, { name: '花椒', grams: 3 }] }),
      request(),
    );
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.reason).toMatch(/没有的食材/);

    const duplicate = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 160 }, { name: '豆芽', grams: 80 }] }),
      request(),
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.ok === false && duplicate.reason).toMatch(/两次/);
  });

  it('全部 0 克 = 把菜谱改空，拒绝（份量引擎会算出 0 g 的买菜清单）', () => {
    const outcome = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 0 }, { name: '蒜', grams: 0 }] }),
      request(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/0 克/);
  });

  it('单「不放蒜」是合法的（一项 0、另一项正数）', () => {
    const outcome = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 160 }, { name: '蒜', grams: 0 }] }),
      request(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.rewrite.ingredients.find((item) => item.name === '蒜')!.grams).toBe(0);
  });

  it('输入里 0 克的待重标项必须被重标成正数（转正不把未定固化成家庭基准）', () => {
    const pending = request({
      recipe: recipe({
        ingredients: [
          { ingredientId: 'bean_sprouts', name: '豆芽', adultGrams: 160, scaling: 'linear', rawCookedAnchor: null },
          { ingredientId: 'garlic', name: '蒜', adultGrams: 0, scaling: 'fixed', rawCookedAnchor: null },
        ],
      }),
    });
    const stillZero = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 160 }, { name: '蒜', grams: 0 }] }),
      pending,
    );
    expect(stillZero.ok).toBe(false);
    expect(stillZero.ok === false && stillZero.reason).toMatch(/待重标/);

    const relabeled = validateRewrite(
      raw({ ingredients: [{ name: '豆芽', grams: 160 }, { name: '蒜', grams: 6 }] }),
      pending,
    );
    expect(relabeled.ok).toBe(true);
  });

  it('口味只收封闭五标签（乱给的丢掉，不因此拒整条）；菜系必须在白名单里', () => {
    const outcome = validateRewrite(raw({ tastes: ['辣', '麻辣', '咸鲜'], cuisine: '京菜' }), request());
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.rewrite.tastes).toEqual(['辣', '咸鲜']);
    expect(outcome.ok === true && outcome.rewrite.cuisine).toBeUndefined();

    const good = validateRewrite(raw({ cuisine: '湘' }), request());
    expect(good.ok === true && good.rewrite.cuisine).toBe('湘');
  });
});

describe('rewriteRecipe：json_object + 失败重试（与导入同一条纪律）', () => {
  it('成功：返回校验过的改写与调用元数据', async () => {
    const llm = createFakeLlmClient();
    llm.setModel('probe-model');
    llm.setCompletion(({ prompt }) => pickPromotionRewrite(prompt)!);

    const outcome = await rewriteRecipe(llm, request({ differences: '不放蒜' }));
    expect(outcome.rewrite).toBeDefined();
    expect(outcome.rewrite!.ingredients.find((item) => item.name === '蒜')!.grams).toBe(0);
    expect(outcome.calls).toBe(1);
    expect(outcome.model).toBe('probe-model');
    expect(outcome.notes).toEqual([]);
  });

  it('形状不合时重试一次（第二次对了就成功）', async () => {
    const llm = createFakeLlmClient();
    llm.queueCompletion('不是 JSON');
    llm.setCompletion(({ prompt }) => pickPromotionRewrite(prompt)!);

    const outcome = await rewriteRecipe(llm, request());
    expect(outcome.rewrite).toBeDefined();
    expect(outcome.calls).toBe(2);
    expect(outcome.notes.join('')).toMatch(/形状不合/);
  });

  it('调用一直失败：不抛，返回 undefined 与可读的原因（域层据此 502）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletionError(new Error('端点不可达'));

    const outcome = await rewriteRecipe(llm, request());
    expect(outcome.rewrite).toBeUndefined();
    expect(outcome.calls).toBe(2);
    expect(outcome.notes.join('')).toMatch(/端点不可达/);
  });

  it('用 json_object 档、低温（离线路径：要的是可复现的家里版本，不是每次都变）', async () => {
    const llm = createFakeLlmClient();
    llm.setCompletion(({ prompt }) => pickPromotionRewrite(prompt)!);
    await rewriteRecipe(llm, request());

    const call = llm.completionCalls[0]!;
    expect(call.request.responseFormat).toBe('json_object');
    expect(call.request.temperature).toBe(0.2);
    expect(call.request.timeoutMs).toBe(30_000);
  });

  it('prompt 版本号是可回溯的一串（与推荐模板分开编号）', () => {
    expect(PROMOTION_PROMPT_VERSION).toBe('2026-09-promotion-v1');
  });
});

describe('pickPromotionRewrite：确定性 fake 的语义', () => {
  it('「不放蒜」→ 蒜 0 克；「多放豆芽」→ 克数上调', () => {
    const prompt = buildPromotionPrompt(request({ differences: '不放蒜、多放豆芽' }));
    const parsed = JSON.parse(pickPromotionRewrite(prompt)!) as PromotionRewrite;
    expect(parsed.ingredients.find((item) => item.name === '蒜')!.grams).toBe(0);
    expect(parsed.ingredients.find((item) => item.name === '豆芽')!.grams).toBeGreaterThan(160);
  });

  it('待重标项被填成正数（fake 的「重标」），口味/步骤/难度沿用输入', () => {
    const pending = request({
      recipe: recipe({
        ingredients: [
          { ingredientId: 'bean_sprouts', name: '豆芽', adultGrams: 160, scaling: 'linear', rawCookedAnchor: null },
          { ingredientId: 'garlic', name: '蒜', adultGrams: 0, scaling: 'fixed', rawCookedAnchor: null },
        ],
      }),
    });
    const parsed = JSON.parse(pickPromotionRewrite(buildPromotionPrompt(pending))!) as PromotionRewrite;
    expect(parsed.ingredients.every((item) => item.grams > 0)).toBe(true);
    expect(parsed.kind).toBe('veg');
    expect(parsed.effort).toBe('quick');
    expect(parsed.steps).toBe(pending.recipe.steps);
    // fake 的输出必须过得了真校验（否则 E2E 验的就不是真实路径）
    expect(validateRewrite(parsed, pending).ok).toBe(true);
  });

  it('prompt 里没有标记段就返回 undefined（fake 回落到别的路，不硬猜）', () => {
    expect(pickPromotionRewrite('随便一段文字')).toBeUndefined();
  });
});
