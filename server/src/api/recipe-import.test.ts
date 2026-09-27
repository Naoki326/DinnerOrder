import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from '../testing/harness.js';
import { pickImportStructure } from '../llm/import-structure.js';
import { pickLlmSelection } from '../llm/prompt.js';
import { pickPromotionRewrite } from '../llm/promotion-schema.js';
import type { Recipe as RecipeJson, RecipeImportPreview } from '../wire-types.js';

/**
 * 菜谱导入（issue #32）：贴链接/贴文字 → 结构化 → 预填编辑器。
 *
 * 接缝与其它 `api/*.test.ts` 一致：`TestHarness` 进程内 HTTP + **确定性 fake LLM**。
 * 本文件只验**外部行为**，四组：
 *
 *   1. **不落库**：这条路的产物是预览。跑完导入，`GET /recipes` 一道新的都没有——
 *      这是本设计最重要的一条断言（ADR-0006 的门槛靠形状守住，不是靠约定）。
 *   2. **预填的形状**：预览里的字段能直接喂给 `POST /recipes`（这是界面的实际用法），
 *      且归一后的食材带的是**字典规范名**而不是模型用的叫法（「西红柿」→「番茄」）。
 *   3. **归一失败不静默**：模型给的字典外食材进 `unmatched`，不进 `ingredients`。
 *   4. **失败映射**：素材太短 → 400 `source_too_short`；LLM 挂了 → 502 `structure_failed`，
 *      且库里仍然什么都没有。
 *
 * 与另外两条 LLM 路的**共存**也在这里验一条（E2E 的 `e2e-server.ts` 靠它）：
 * 同一个 fake 同时服务导入/推荐/转正三条路，靠 prompt 标记分派——分派错了会互相串味。
 */

let harness: TestHarness;

afterEach(() => {
  harness?.close();
});

/**
 * 装上与生产/E2E **同一条分派**的 fake（导入 → 转正 → 推荐，靠互不重叠的 prompt 标记）。
 *
 * 不装它的话 `createFakeLlmClient` 的缺省行为是回显 prompt，`structureRecipeSource` 会把它当
 * 形状不合而重试两次后报 502——所以本文件里每个用例都得先装上。
 */
function useProductionFake(): void {
  harness.llm.setCompletion(
    (request) =>
      pickImportStructure(request.prompt) ??
      pickPromotionRewrite(request.prompt) ??
      pickLlmSelection(request.prompt) ??
      '{"dishes":[]}',
  );
}

/** 一个像样的素材（够长、含几项已知食材，让 fake 的结构化能认出东西） */
const SOURCE_TEXT =
  '牛肉豆腐煲做法：牛肉切薄片，加姜丝、生抽、淀粉腌 15 分钟。砂锅下葱蒜爆香，放番茄炒出汁，' +
  '铺上娃娃菜、海鲜菇和豆腐，淋料汁焖 5 分钟，最后把牛肉摊开铺上去再焖 3 分钟，撒香菜。';

async function importFrom(body: unknown): Promise<{ status: number; body: { preview?: RecipeImportPreview; error?: string; notes?: string[] } }> {
  return harness.json('/api/recipes/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 建 harness 并装上生产同款 fake（下面每个用例开头的固定动作） */
function start(): TestHarness {
  harness = createTestHarness();
  useProductionFake();
  return harness;
}

async function listAll(): Promise<RecipeJson[]> {
  const { body } = await harness.json<{ recipes: RecipeJson[] }>('/api/recipes?status=all');
  return body.recipes;
}

describe('导入：从粘贴的文字', () => {
  it('产出一份预填编辑器的初值，且**不落库**', async () => {
    start();
    const before = await listAll();

    const { status, body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    expect(status).toBe(200);
    const preview = body.preview!;
    expect(preview.name).not.toBe('');
    expect(preview.kind).toBe('meat');
    expect(preview.ingredients.length).toBeGreaterThan(0);
    expect(preview.sourceRef).toBe('粘贴的文字');
    expect(preview.llm?.model).toBe('fake-llm');
    // **最重要的一条**：库里一道新的都没有（预览不是写）
    expect(await listAll()).toHaveLength(before.length);
  });

  it('归一用字典规范名：模型说「西红柿」，预览里是「番茄」', async () => {
    start();
    const { body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    const tomato = body.preview!.ingredients.find((item) => item.ingredientId === 'tomato');
    expect(tomato?.name).toBe('番茄');
  });

  it('预览能直接喂给 POST /recipes 落库（界面的实际用法），链接原样记进 sourceRef', async () => {
    start();
    const { body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    const preview = body.preview!;

    const created = await harness.json<{ recipe: RecipeJson }>('/api/recipes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: preview.name,
        kind: preview.kind,
        effort: preview.effort,
        cuisine: preview.cuisine,
        tastes: preview.tastes,
        seasonMonths: preview.seasonMonths,
        steps: preview.steps,
        ingredients: preview.ingredients.map((item) => ({ ingredientId: item.ingredientId, adultGrams: item.adultGrams })),
        sourceRef: preview.sourceRef,
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.recipe.source).toBe('oral'); // 与手写录入同一档信任（ADR-0009/0011）
    expect(created.body.recipe.status).toBe('active');
    expect(created.body.recipe.sourceRef).toBe('粘贴的文字');
    expect(created.body.recipe.neverServed).toBe(true);
  });

  it('素材太短：400 source_too_short（不硬编一道菜）', async () => {
    start();
    const { status, body } = await importFrom({ source: { kind: 'text', text: '牛肉' } });
    expect(status).toBe(400);
    expect(body.error).toBe('source_too_short');
  });

  it('空文字被 zod 挡在门外（400 invalid_request）', async () => {
    start();
    const { status, body } = await importFrom({ source: { kind: 'text', text: '   ' } });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });

  it('非 http 的链接被挡住（只收 http(s)，不认平台域名）', async () => {
    start();
    const { status, body } = await importFrom({ source: { kind: 'url', url: 'file:///etc/passwd' } });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});

describe('导入：归一失败与克数缺失都不静默', () => {
  it('字典外的食材进 unmatched，不进 ingredients（掌勺者照这个手动加）', async () => {
    start();
    // 直接把出参换成含字典外食材的（fake 的词表认不出「佛跳墙专用料」，用不了它来造这一档）
    harness.llm.setCompletion(
      JSON.stringify({
        name: '牛肉豆腐煲',
        kind: 'meat',
        effort: 'medium',
        tastes: ['咸鲜'],
        steps: '做法略',
        ingredients: [
          { name: '牛肉', grams: 150 },
          { name: '佛跳墙专用料', grams: 20 },
          { name: '豆腐', grams: 200 },
        ],
      }),
    );

    const { status, body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    expect(status).toBe(200);
    const preview = body.preview!;

    // 归不上的那一项**被点名**，带它原本想放的克数（补完字典不用重新估）
    expect(preview.unmatched).toHaveLength(1);
    expect(preview.unmatched[0]!.name).toBe('佛跳墙专用料');
    expect(preview.unmatched[0]!.grams).toBe(20);
    expect(preview.unmatched[0]!.reason).toContain('字典');
    // 且它**不在**食材清单里（不静默地当成认得了）
    expect(preview.ingredients.map((item) => item.name)).toEqual(['牛肉', '豆腐']);
    // notes 里也要有这一条（成功但需要注意的事不静默）
    expect(preview.notes.join('')).toContain('没对上字典');
  });

  it('没给克数的项照样进预览，克数为 0 且被点名（编辑器会拦下保存让他填）', async () => {
    start();
    harness.llm.setCompletion(
      JSON.stringify({
        name: '牛肉豆腐煲',
        kind: 'meat',
        effort: 'medium',
        tastes: ['咸鲜'],
        steps: '做法略',
        // 「适量」类没给克数 → grams 为 null
        ingredients: [
          { name: '牛肉', grams: 150 },
          { name: '香菜', grams: null },
        ],
      }),
    );

    const { body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    const preview = body.preview!;
    const coriander = preview.ingredients.find((item) => item.name === '香菜');
    // 0 = 还没填（编辑器会标红、不给保存）；**不是**库里的「待重标」（预览不落库）
    expect(coriander?.adultGrams).toBe(0);
    expect(preview.notes.join('')).toContain('没给出克数');
    expect(preview.notes.join('')).toContain('香菜');
  });

  it('两种叫法归到同一个食材时合并成一项（否则保存时会撞主键）', async () => {
    start();
    harness.llm.setCompletion(
      JSON.stringify({
        name: '番茄炒蛋',
        kind: 'veg',
        effort: 'quick',
        tastes: ['咸鲜'],
        steps: '做法略',
        ingredients: [
          { name: '西红柿', grams: 150 },
          { name: '番茄', grams: 150 },
          { name: '鸡蛋', grams: 60 },
        ],
      }),
    );

    const { body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    const preview = body.preview!;
    expect(preview.ingredients.map((item) => item.name)).toEqual(['番茄', '鸡蛋']);
    expect(preview.notes.join('')).toContain('已合并');
  });

  it('「水」不进食材清单（模型常把它列成一项，让掌勺者为水填克数是纯噪音）', async () => {
    start();
    harness.llm.setCompletion(
      JSON.stringify({
        name: '牛肉豆腐煲',
        kind: 'meat',
        effort: 'medium',
        tastes: ['咸鲜'],
        steps: '做法略',
        // 真链路实测的形状：素材里「加小半碗清水」被模型列成一项无克数的食材
        ingredients: [
          { name: '牛肉', grams: 120 },
          { name: '清水', grams: null },
          { name: '豆腐', grams: 200 },
        ],
      }),
    );

    const { body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    const preview = body.preview!;
    expect(preview.ingredients.map((item) => item.name)).toEqual(['牛肉', '豆腐']);
    // 丢掉这件事本身要说出来（不静默），且不该混进「克数待填」那句
    expect(preview.notes.join('')).toContain('没把「清水」列进食材');
    expect(preview.notes.join('')).not.toContain('没给出克数');
  });
});

describe('导入：LLM 失败不落半截', () => {
  it('结构化失败 → 502 structure_failed，库里仍然什么都没有', async () => {
    start();
    harness.llm.setCompletionError(new Error('端点不可达'));
    const before = await listAll();

    const { status, body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    expect(status).toBe(502);
    expect(body.error).toBe('structure_failed');
    // 失败细节要带出来（不静默）
    expect((body.notes ?? []).join('')).toContain('失败');
    expect(await listAll()).toHaveLength(before.length);
  });

  it('出参形状不合时重试一次仍不合就报 502（不是静默给空菜谱）', async () => {
    start();
    harness.llm.setCompletion('{"name":"","kind":"meat","effort":"quick","ingredients":[{"name":"牛肉"}]}');
    const { status, body } = await importFrom({ source: { kind: 'text', text: SOURCE_TEXT } });
    expect(status).toBe(502);
    expect(body.error).toBe('structure_failed');
    // 两次尝试都记在案（形状不合 → 重试 → 仍不合）
    expect(harness.llm.completionCalls.length).toBe(2);
  });
});

describe('与另外两条 LLM 路共存（e2e-server 的分派靠这几条）', () => {
  it('导入的 prompt 标记不会与推荐/转正串味', () => {
    // 导入的路由
    const importPrompt = ['【来源素材】', JSON.stringify({ title: '番茄炒蛋', text: SOURCE_TEXT })].join('\n');
    expect(pickImportStructure(importPrompt)).toBeDefined();
    // 它不是推荐那条路的输入
    expect(pickLlmSelection(importPrompt)).toBeUndefined();
    // 也不是转正那条路的输入
    expect(pickPromotionRewrite(importPrompt)).toBeUndefined();
  });

  it('真实的推荐 prompt 不会被导入那条路截胡', () => {
    const recommendationPrompt = ['【候选池】', '[]', '【本餐结构】', '{}'].join('\n');
    expect(pickImportStructure(recommendationPrompt)).toBeUndefined();
  });
});
