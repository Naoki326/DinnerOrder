import { z } from 'zod';
import { LlmCallError, type LlmClient } from './types.js';
import { sectionAfter, stripCodeFence } from './prompt.js';
import { CUISINES } from './import-schema.js';
import type { RecipeCuisine, RecipeEffort, RecipeKind } from '../wire-types.js';

/**
 * 导入期的**结构化**出参形状（issue #32）：把一段外部素材（链接正文 / 粘贴的文字）
 * 读成一份**预填编辑器**的初值。
 *
 * 与另外两条 LLM 路径的分工，别混：
 *   * `import-schema.ts`（#19）：批量外部池草稿的**重标**与菜系初打——输入已是结构化的菜谱。
 *   * `promotion-schema.ts`（#21）：转正时在**已有菜谱**上改写。
 *   * 本模块：从**非结构化文本**里读出整道菜（菜名/荤素位/难度/菜系/口味/做法/食材名 + 克数初值）。
 *     这是三条里唯一「从零建档」的一条，所以它产出的是**完整预览**而不是补丁。
 *
 * 三条纪律（与另外两条同族）：
 *
 * 1. **离线路径**：导入时跑一次，不在任何运行时数值路径上。ADR-0004 的「LLM 不进数值路径」
 *    依然成立——这里给的克数是**入库前的初值**，掌勺者在编辑器里看过才落库（ADR-0011）。
 * 2. **只走 `json_object` + Zod 校验 + 失败重试**：本机代理端点不支持 strict json_schema
 *    （preflight 实测），与另外两条同一条通道。
 * 3. **不猜克数**：模型没给克数的项**留着 `grams: null`** 交给下一层（归一后仍无克数的项
 *    在预览里标出来让掌勺者填），**不由这层编一个数**。库里 0 克 = 待重标（迁移 005），
 *    而预览不是落库——两件事不要混。
 *
 * **不落库**：本模块只产出预览。落库走 `POST /recipes`（`status='active'`），也就是
 * 「模型产出的东西一定有人看过」（ADR-0006 的门槛、ADR-0011 的信任根）。
 */

/** 改了 prompt 措辞或输入形状就 +1（留痕里的版本号，历史导入靠它对回当时的模板） */
export const IMPORT_PROMPT_VERSION = '2026-09-import-v1';

/** 输入里的「来源素材」机器可读标记（fake 与测试靠它从 prompt 里读回输入） */
export const SOURCE_MARK = '【来源素材】';

/** 口味封闭五标签（与迁移 006 的 CHECK、`api/recipes.ts` 的 TASTES 同源；这里只做过滤，不拒整条） */
const TASTE_WHITELIST = new Set(['甜', '辣', '酸', '咸鲜', '清淡']);

/** 模型给出的结构化结果（**未过滤**：菜系值域、口味白名单、克数区间还要过 `validateStructured`） */
export interface StructuredRecipe {
  name: string;
  kind: RecipeKind;
  effort: RecipeEffort;
  cuisine?: string;
  tastes: string[];
  seasonMonths: number[];
  steps: string;
  ingredients: { name: string; grams: number | null }[];
}

/**
 * 校验通过的结构化结果。
 *
 * 与 `StructuredRecipe` 的差别：菜系已落进封闭集合（不在集合里就当没给）、口味已过滤、
 * `ingredients` 已去重（同一食材名只留第一条）且**去掉了空名项**。
 */
export interface ValidatedStructure {
  name: string;
  kind: RecipeKind;
  effort: RecipeEffort;
  cuisine: RecipeCuisine | null;
  tastes: string[];
  seasonMonths: number[];
  steps: string;
  ingredients: { name: string; grams: number | null }[];
}

const STRUCTURE_SCHEMA = z.object({
  /** 菜名：必填。素材里读不出菜名时**这次导入失败**——别让模型硬编一个（那会污染家庭菜谱库） */
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['meat', 'veg', 'soup_meat', 'soup_veg']),
  effort: z.enum(['quick', 'medium', 'heavy']),
  cuisine: z.string().optional(),
  /** 口味标签（值域在 `validateStructured` 里按封闭五标签过滤，不在这里拒整条） */
  tastes: z.array(z.string().min(1)).default([]),
  seasonMonths: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  /** 做法步骤（可空：素材里没写做法时留空，编辑器里由掌勺者补） */
  steps: z.string().default(''),
  ingredients: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        /**
         * 成人份克数：**`null` 是合法值**（素材没给、模型判不出），下一层标出来让掌勺者填。
         * 给了就必须在 1–2000：下界防 0（0 在库里的含义是「待重标」，不该从这条路产生），
         * 上界防幻觉（2000g 一个食材项已远超任何家常菜）。
         */
        grams: z.number().positive().max(2000).nullable().default(null),
      }),
    )
    .min(1, '食材清单不能为空'),
});

/** prompt 里【来源素材】段的形状（fake 与测试读它） */
interface PromptSourceInput {
  title: string;
  text: string;
}

const SYSTEM_PROMPT = [
  '你是中国家庭的菜谱整理助手。用户给你一段**来源素材**（可能是某个菜谱视频的字幕转录、',
  '网页正文、或者别人发来的一段做法文字），你要把它整理成一道菜的**结构化菜谱**。',
  '严格遵守：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
  '2. 只整理素材里**真的有**的信息，**不要**补充素材里没有的食材、步骤或说法。素材里没提克数，',
  '   就把 grams 写成 null，不要编一个数。',
  '3. 菜名取素材里的菜名；素材里没给名字时，用一个描述这道菜的家常名字（如「番茄炒蛋」）。',
  '4. 食材清单**逐项列出**，名字用家常说法（「西红柿」写「番茄」也可以），**不要合并**',
  '   「调料」这类分组；调味料也要逐项列（生抽/蚝油/盐/淀粉…）。',
  '5. grams 是「一个成人一餐这道菜时的生重克数」，按中式家常口径给**参考值**——',
  '   参考量：叶菜 150–250g、根茎 100–200g、肉 100–150g、鸡蛋 50–60g、豆腐 150–250g、',
  '   蒜 5–10g、姜 3–8g、葱 5–15g、盐 2–3g、生抽 10–15g、蚝油 5–10g、油 10–15g、淀粉 5–10g。',
  '   素材里写了明确克数就照它；写了「一勺」「少许」这类就按上面的参考量给一个中间值。',
  '6. 荤素汤位：有肉/鱼/虾/蛋的主菜是 meat；纯素是 veg；汤类按有无荤料分 soup_meat / soup_veg。',
  '7. 难度：20 分钟内能做完是 quick；需要炖/焖/炸等较长工序是 heavy；其余是 medium。',
  '8. 口味只从这五个里选（可多选）：甜、辣、酸、咸鲜、清淡。',
  '9. 菜系只从这五个封闭集合里选一个，拿不准就给「家常」：',
  `   ${CUISINES.join('、')}。`,
  '10. 做法步骤：把素材里的手法按顺序写下来，**每步一行**（用 \\n 分隔），不要拼成一整段；',
  '    素材里有的关键手法（「分两次打水」「摊开不要堆在一起」）要保留；素材里没写做法就给空串。',
  '输出 JSON 形状：',
  '{"name":"番茄炒蛋","kind":"veg","effort":"quick","cuisine":"家常","tastes":["咸鲜"],',
  ' "seasonMonths":[],"steps":"1. 番茄切块\\n2. 鸡蛋打散加盐\\n3. 热锅下油炒蛋盛出",',
  ' "ingredients":[{"name":"番茄","grams":150},{"name":"鸡蛋","grams":60}]}',
].join('\n');

export interface ImportLlmOptions {
  /** 最多试几次（网络抖动重试 1 次；形状不合也重试 1 次） */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface ImportStructureOutcome {
  /** 校验通过的结构化结果；undefined = 这次没成（调用失败或形状不合） */
  structure?: ValidatedStructure;
  calls: number;
  /** 失败/丢弃的说明（进响应的 notes，不静默） */
  notes: string[];
  /** 最后一次成功调用的元数据（失败时 undefined） */
  model?: string;
  latencyMs: number;
}

/**
 * 把来源素材结构化成一道菜。**失败返回 undefined 而不抛**：调用方据此报 502 并让掌勺者重试
 * ——半截的预览比失败危险（他可能没注意食材少了两项就保存了）。
 */
export async function structureRecipeSource(
  llm: LlmClient,
  source: { title: string; text: string },
  options: ImportLlmOptions = {},
): Promise<ImportStructureOutcome> {
  const prompt = buildImportPrompt(source);
  const maxAttempts = options.maxAttempts ?? 2;
  const notes: string[] = [];
  let calls = 0;
  let model: string | undefined;
  let latencyMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    calls += 1;
    try {
      const result = await llm.complete({
        system: SYSTEM_PROMPT,
        prompt,
        responseFormat: 'json_object',
        timeoutMs: options.timeoutMs ?? 45_000,
        // 结构化要的是**可比对的稳定结果**，不是每次跑都变的菜谱（与另两条同一温度）
        temperature: 0.2,
      });
      model = result.model;
      latencyMs += result.latencyMs;
      const parsed = STRUCTURE_SCHEMA.safeParse(parseJson(result.text));
      if (!parsed.success) {
        notes.push(`结构化出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
        continue;
      }
      const checked = validateStructured(parsed.data);
      if (!checked.ok) {
        notes.push(checked.reason);
        continue;
      }
      return { structure: checked.structure, calls, notes, model, latencyMs };
    } catch (cause) {
      const reason = cause instanceof LlmCallError ? cause.message : String(cause);
      notes.push(`结构化第 ${calls} 次调用失败：${reason}`);
    }
  }

  return { structure: undefined, calls, notes, latencyMs: 0 };
}

/** prompt 的正文：来源素材（标题 + 正文）。空标题不占位，免得模型把空行当信息 */
export function buildImportPrompt(source: { title: string; text: string }): string {
  const payload = JSON.stringify({ title: source.title.trim(), text: source.text.trim() });
  return [`${SOURCE_MARK}`, payload].join('\n');
}

/**
 * 出参的**语义**校验（Zod 只管形状）：
 *   * 菜系不在封闭集合里 → **当没给**（放宽为 null），不拒整条——一个菜系 tag 不值得让整次导入失败；
 *   * 口味不在封闭五标签里 → 丢掉那一个（同一条理由）；
 *   * 食材按名字去重（同一个食材给两次会让 `recipe_ingredients` 的主键撞车）；
 *   * 至少留下一项食材、且**菜名非空**（Zod 已挡，这里是直接调域时的兜底）。
 */
export function validateStructured(raw: StructuredRecipe): { ok: true; structure: ValidatedStructure } | { ok: false; reason: string } {
  const name = raw.name.trim();
  if (name === '') return { ok: false, reason: '结构化结果里没有菜名' };

  const ingredients: { name: string; grams: number | null }[] = [];
  const seen = new Set<string>();
  for (const item of raw.ingredients) {
    const itemName = item.name.trim();
    if (itemName === '') continue;
    if (seen.has(itemName)) continue;
    seen.add(itemName);
    // 克数照原样带上（含 null）——「填不上克数」由下一层标出来让掌勺者处理，这里不编数
    ingredients.push({ name: itemName, grams: item.grams === null ? null : round1(item.grams) });
  }
  if (ingredients.length === 0) return { ok: false, reason: '结构化结果里没有可用的食材项' };

  const cuisine = CUISINES.includes(raw.cuisine as RecipeCuisine) ? (raw.cuisine as RecipeCuisine) : null;
  const tastes = [...new Set(raw.tastes.filter((taste) => TASTE_WHITELIST.has(taste)))];
  const seasonMonths = [...new Set(raw.seasonMonths)].sort((a, b) => a - b);

  return {
    ok: true,
    structure: {
      name,
      kind: raw.kind,
      effort: raw.effort,
      cuisine,
      tastes,
      seasonMonths,
      steps: raw.steps.trim(),
      ingredients,
    },
  };
}

// ---------------------------------------------------------------- 确定性 fake（E2E 与单测共用）

/**
 * 从 prompt 里读回【来源素材】，产出一份**确定性的**结构化结果。
 *
 * 为什么要它：E2E 与单测要验的是**管线**（取正文 → 结构化 → 归一 → 预填编辑器 → 落库），
 * 不是模型的品味。真调用不确定（同一素材两次给不同的菜），断言只能写成「有几项」这种弱命题。
 * 这个 fake 与 `promotion-schema.ts` 的 `pickPromotionRewrite` 同一路数：
 * **解析 prompt 输入 → 用确定性规则算出合法出参**。
 *
 * 它做的三件事（够真实管线的形状，又完全确定）：
 *   1. 菜名：素材标题里有就用；否则从正文里找「XX煲/XX汤/XX炒XX」这类词；
 *   2. 食材：扫正文里出现的**已知家常食材词表**（固定表，不查库——fake 不碰数据库）；
 *   3. 克数：按词表给固定中间值，**没在词表里的名字给 null**（于是「克数待填」这条路径
 *      在 E2E 里也真的被走到）。
 *
 * 返回 undefined = 这不是导入 prompt（调用方接着试别的路径）。
 */
export function pickImportStructure(prompt: string): string | undefined {
  const block = sectionAfter(prompt, SOURCE_MARK);
  if (!block) return undefined;
  let input: PromptSourceInput;
  try {
    const raw = JSON.parse(block) as PromptSourceInput;
    if (typeof raw.text !== 'string') return undefined;
    input = raw;
  } catch {
    return undefined;
  }

  const corpus = `${input.title}\n${input.text}`;
  const name = input.title.trim() !== '' ? input.title.trim() : guessName(corpus);
  const ingredients = FAKE_INGREDIENTS.filter((entry) => entry.words.some((word) => corpus.includes(word))).map(
    (entry) => ({ name: entry.name, grams: entry.grams }),
  );
  // 一个食材都没认出来也要给一个合法形状（Zod 要求 ≥1 项）：给素材里第一个「像食材」的短词
  if (ingredients.length === 0) ingredients.push({ name: '食材待补', grams: null });

  const kind = guessKind(name, corpus);

  return JSON.stringify({
    name: name === '' ? '待命名' : name,
    kind,
    effort: /炖|焖|煲|烧|炸/.test(corpus) ? 'heavy' : 'quick',
    cuisine: '家常',
    tastes: [/辣/.test(corpus) ? '辣' : '咸鲜'],
    seasonMonths: [],
    steps: input.text.trim(),
    ingredients,
  });
}

/**
 * 荤素汤位的确定性判定。
 *
 * **「煲」不是汤**：`砂锅焖` 出来的「XX煲」（豆腐煲、鸡煲）是**菜**，不是一锅汤——
 * 只有名字里真带「汤/羹」才归汤位。这个区分不是抬杠：汤位与菜位在整餐结构里占不同的坑
 * （家规是 2 荤 1 素 1 汤），判错了整餐都搭不对。
 */
function guessKind(name: string, corpus: string): RecipeKind {
  const hasMeat = /肉|牛|猪|鸡|排骨|虾|鱼|蛋/.test(`${name}${corpus}`);
  if (/汤|羹/.test(name)) return hasMeat ? 'soup_meat' : 'soup_veg';
  return hasMeat ? 'meat' : 'veg';
}

/** fake 的食材词表：`words` 是素材里出现的写法，`name` 是给模型的规范念法，`grams` 是固定的家常中间值 */
const FAKE_INGREDIENTS: { name: string; words: string[]; grams: number | null }[] = [
  { name: '牛肉', words: ['牛肉', '牛里脊', '牛腩', '吊龙', '雪花'], grams: 150 },
  { name: '豆腐', words: ['豆腐'], grams: 200 },
  { name: '娃娃菜', words: ['娃娃菜'], grams: 120 },
  { name: '番茄', words: ['番茄', '西红柿'], grams: 150 },
  { name: '鸡蛋', words: ['鸡蛋', '蛋'], grams: 60 },
  { name: '土豆', words: ['土豆', '马铃薯'], grams: 150 },
  { name: '海鲜菇', words: ['海鲜菇', '蟹味菇'], grams: 100 },
  { name: '金针菇', words: ['金针菇'], grams: 150 },
  { name: '葱', words: ['葱'], grams: 10 },
  { name: '姜', words: ['姜丝', '姜', '生姜'], grams: 8 },
  { name: '蒜', words: ['蒜'], grams: 10 },
  { name: '香菜', words: ['香菜'], grams: 5 },
  { name: '小米辣', words: ['小米辣', '小米椒'], grams: 5 },
  { name: '生抽', words: ['生抽'], grams: 15 },
  { name: '蚝油', words: ['蚝油'], grams: 10 },
  { name: '盐', words: ['盐'], grams: 3 },
  { name: '黑胡椒粉', words: ['黑胡椒', '胡椒粉'], grams: 1 },
  { name: '淀粉', words: ['淀粉', '生粉'], grams: 8 },
  { name: '食用油', words: ['食用油', '植物油', '油热'], grams: 15 },
];

/**
 * 从素材里猜菜名。**真实模型会取「XX 的做法：」里的 XX**，所以 fake 也先看这个形状
 * （素材里那份标题式写法是最强的菜名信号）；没有再找「XX煲 / XX汤 / XX炒XX」这类家常菜名。
 * 这仍然是 fake 的启发式，不是产品逻辑（产品逻辑是 prompt 里那几句要求）。
 */
function guessName(corpus: string): string {
  const titled = /([一-龥A-Za-z0-9·]{2,14})\s*(?:的)?\s*(?:做法|菜谱|教程)/.exec(corpus);
  if (titled?.[1]) return titled[1];
  const patterns = [/[一-龥]{2,5}煲/, /[一-龥]{2,5}汤/, /[一-龥]{2,4}炒[一-龥]{1,3}/];
  for (const pattern of patterns) {
    const hit = pattern.exec(corpus);
    if (hit) return hit[0];
  }
  return '';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** JSON.parse 前的清洗：剥掉 markdown 代码块（与另两条同一条） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return undefined;
  }
}
