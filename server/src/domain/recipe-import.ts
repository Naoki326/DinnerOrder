import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';
import type { RecipeImportPreview, RecipeImportUnmatched } from '../wire-types.js';
import { loadIngredientIndex, normalizeIngredientName } from './library.js';
import {
  structureRecipeSource,
  type ValidatedStructure,
} from '../llm/import-structure.js';
import { extractFromText, extractFromUrl, type ExtractedSource } from '../import/extract.js';

/**
 * 菜谱导入（issue #32）：**来源素材 → 预填编辑器**。
 *
 * 这条路的形状是刻意的：**它不落库**。产出是一份 `RecipeImportPreview`，界面把它塞进
 * `RecipeEditor` 的草稿；掌勺者校对后走既有的 `POST /recipes`（`status='active'`、`source='oral'`）。
 * 三个好处，每一个都是这份设计存在的理由：
 *
 *   1. **ADR-0006 的门槛不用动**：LLM 产出的东西**必然有人看过**才可能进库——因为这条路上
 *      根本没有「直接入库」的函数。门槛不是靠一句约定守住的，是靠形状守住的。
 *   2. **归一失败项有人当场处理**：掌勺者正在编辑器里、字典搜框就在手边（`AddIngredient`），
 *      这是补名字最便宜的时刻——而不是让它们进报告、等谁去翻。
 *   3. **预览可反复**：素材不行就换一段再导，库里不会留下半截草稿（与 `library.ts` 的
 *      `importDrafts` 那条批处理路相反：那条整批一个事务，因为它面向后台批量；这条面向人，一次一道）。
 *
 * 归一复用 `domain/library.ts` 的既有实现（`loadIngredientIndex` + `normalizeIngredientName`），
 * **不另写一套匹配**：两套匹配就是两个漂移点，而「归上了哪个食材」直接决定忌口关联（隐性忌口靠
 * 食材清单展开），认错一个字的代价是把忌口挂错食材。
 */

/** 素材读不出来（链接取不到 / 文字太短）：界面要提示改用另一种输入 */
export class ImportSourceError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportSourceError';
  }
}

/** 结构化失败（LLM 不可用 / 形状不合）：整次失败，库里什么都不留 */
export class ImportStructureError extends Error {
  constructor(readonly notes: string[]) {
    super('AI 没能把这段素材整理成菜谱');
    this.name = 'ImportStructureError';
  }
}

export interface ImportRecipeOptions {
  /** 注入 fetch（仅链接那条路用；测试不联网） */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 把来源素材转成一份预填编辑器的初值。
 *
 * 三段各自可以失败，失败映射到不同的用户动作：
 *   * **取正文失败** → `ImportSourceError`：换一种输入（贴文字）
 *   * **结构化失败** → `ImportStructureError`：重试（LLM 抖动）或改用贴文字
 *   * **归一失败项** → **不是错误**：进 `unmatched`，摆到编辑器里让掌勺者处理
 */
export async function importRecipe(
  db: Db,
  llm: LlmClient,
  source: { kind: 'url'; url: string } | { kind: 'text'; text: string },
  options: ImportRecipeOptions = {},
): Promise<RecipeImportPreview> {
  const notes: string[] = [];

  // ① 取正文
  let extracted: ExtractedSource;
  try {
    extracted =
      source.kind === 'url'
        ? await extractFromUrl(source.url, options)
        : extractFromText(source.text);
  } catch (cause) {
    throw new ImportSourceError(
      cause instanceof Error ? cause.name : 'unknown',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  notes.push(...extracted.notes);

  // ② 结构化（离线 LLM 路径；失败即整次失败，不落任何东西）
  const outcome = await structureRecipeSource(llm, { title: extracted.title, text: extracted.text }, options);
  if (!outcome.structure) {
    throw new ImportStructureError([...notes, ...outcome.notes]);
  }
  notes.push(...outcome.notes);

  // ③ 归一：把模型给的名字对上字典
  const map = mapIngredients(db, outcome.structure, notes);

  return {
    name: outcome.structure.name,
    kind: outcome.structure.kind,
    effort: outcome.structure.effort,
    cuisine: outcome.structure.cuisine,
    tastes: outcome.structure.tastes as RecipeImportPreview['tastes'],
    seasonMonths: outcome.structure.seasonMonths,
    steps: outcome.structure.steps,
    ingredients: map.ingredients,
    unmatched: map.unmatched,
    sourceRef: extracted.sourceRef,
    notes,
    llm: outcome.model
      ? { model: outcome.model, latencyMs: outcome.latencyMs, calls: outcome.calls }
      : null,
  };
}

/**
 * 水（含开水）不进导入预览的食材清单。
 *
 * 这是实测出来的真摩擦：素材里「加小半碗清水」这类**是做法的一句指令**，模型会把它列成一项
 * 食材（本轮真链路：牛肉豆腐煲的 14 项里第 14 项就是「水」，克数缺，于是卡住保存）。
 * 让掌勺者为水填克数是纯噪音：它**不需要买**（`PANTRY_STAPLES` 里就水），而且家常口径
 * 下它对份量引擎的贡献是 0（`ingredient_nutrition` 里水是 0 kcal）。
 *
 * 为什么是**丢掉**而不是「给个默认值」：本模块的纪律是**不猜克数**（不编一个数），
 * 而丢一项与编一个数是两件事——丢掉的写进 notes，他随时能手动加回来。
 */
const WATER_INGREDIENT_IDS = new Set(['water', 'hot_water']);

/**
 * 逐项归一。三档处置，**每一档都不静默**：
 *
 *   * **归上了** → 进 `ingredients`（带字典的规范名，界面直接显示）；
 *   * **归上了但同名重复**（模型给了「西红柿」又给了「番茄」）→ 合并成一项，克数取第一项，
 *     并记一条 note。数据库那边 `recipe_ingredients` 的主键是 (recipe_id, ingredient_id)，
 *     不去重就会在保存时撞车——**在这里合并比在保存时报错好**（掌勺者已经校对过前面的项了）；
 *   * **归不上** → 进 `unmatched`，带模型给的克数（他知道「原来想放多少」）与一句原因。
 *
 * 克数缺失（`grams === null`）的项目**照样进 `ingredients`**，但克数为 0 会让既有编辑器的
 * 校验挡住保存（红框 + 不给保存）——这正是我们要的：**他必须为这一项填一个数**，
 * 而不是让一个「待定」悄悄存进库（库里 0 克的含义是「待重标」，不该从这条路产生）。
 */
export function mapIngredients(
  db: Db,
  structure: ValidatedStructure,
  notes: string[],
): { ingredients: RecipeImportPreview['ingredients']; unmatched: RecipeImportUnmatched[] } {
  const index = loadIngredientIndex(db);
  const ingredients: RecipeImportPreview['ingredients'] = [];
  const unmatched: RecipeImportUnmatched[] = [];
  const byId = new Map<string, number | null>();
  const dropped: string[] = [];

  for (const item of structure.ingredients) {
    const hit = normalizeIngredientName(index, item.name);
    if (!hit) {
      unmatched.push({
        name: item.name,
        grams: item.grams,
        reason: '食材字典里没有对得上的条目',
      });
      continue;
    }
    if (WATER_INGREDIENT_IDS.has(hit.id)) {
      dropped.push(item.name);
      continue;
    }
    if (byId.has(hit.id)) {
      // 同名归并：模型用了两种叫法（「西红柿」与「番茄」）——合并而不是让保存时撞主键
      notes.push(`「${item.name}」与前面的项归到了同一个食材（${index.nameOf.get(hit.id) ?? hit.id}），已合并`);
      continue;
    }
    const grams = item.grams === null ? 0 : item.grams;
    byId.set(hit.id, grams);
    ingredients.push({
      ingredientId: hit.id,
      name: index.nameOf.get(hit.id) ?? item.name,
      // 0 = 还没填（编辑器会拦下保存）。**不是**库里的「待重标」——预览不落库
      adultGrams: grams,
    });
  }

  if (dropped.length > 0) {
    notes.push(`没把「${[...new Set(dropped)].join('、')}」列进食材（水不用买、也不影响份量）`);
  }
  const missing = ingredients.filter((item) => item.adultGrams <= 0).map((item) => item.name);
  if (missing.length > 0) {
    notes.push(`有 ${missing.length} 项没给出克数（${missing.join('、')}），保存前要填上`);
  }
  if (unmatched.length > 0) {
    notes.push(`有 ${unmatched.length} 项食材没对上字典（${unmatched.map((item) => item.name).join('、')}）`);
  }
  return { ingredients, unmatched };
}
