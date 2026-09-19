import { z } from 'zod';
import { LlmCallError, type LlmClient } from './types.js';
import { sectionAfter, stripCodeFence } from './prompt.js';
import { CUISINES } from './import-schema.js';
import type { Recipe, RecipeCuisine, RecipeEffort, RecipeKind } from '../wire-types.js';

/**
 * 转正期的 LLM 出参形状（总纲 §2.8「转正机制」：外部菜谱被预定上桌 → 掌勺者点「转正」→
 * 可口述差异（多点辣/不放蒜）→ **LLM 在原菜谱上改写成家里版本** → 进家庭库 + 推荐池）。
 *
 * 与导入期的重标/菜系初打同一条纪律（`import-schema.ts` 的文件头，三条原样适用）：
 * 这是**离线路径**（转正时跑一次），与运行时数值路径（ADR-0004 的纯规则查表）严格分开；
 * 出参只走 `json_object` + Zod 校验 + 失败重试（本机代理端点不支持 strict json_schema）。
 *
 * 与导入期不同的两处，也是本模块存在的理由：
 *
 * 1. **一次一道、带完整上下文**：导入是批量（150–300 道），转正是掌勺者站在灶台前点一下——
 *    一次一道，把整份菜谱（食材 + 克数 + 份量原文 + 口味 + 做法）都给模型，
 *    因为「不放蒜」这种口述要落在**这一道菜**的食材清单上，批量的紧凑格式反而丢信息。
 * 2. **改写而不只是补数**：模型可以改克数（「多点辣」→ 辣椒加量）、把某味食材标成 0（不放）、
 *    改难度、补菜系。它**不能**改菜名/别名/来源（那三样是身份，见 `domain/promotion.ts` 的
 *    `promoteRecipe`）。
 *
 * ⚠️ **两种 0 不要混**（迁移 005 与 `domain/promotion.ts` 是权威）：
 *   * 库里 `adult_grams = 0` 的**唯一**含义是**模糊份量待 LLM 重标**（`source_quantity` 存
 *     采集到的原文当证据）——它**不是**「确认不放」，转正路径也从不往库里写这个 0；
 *   * 本模块出参里的 `grams: 0` 才是「掌勺者口述确认不放」。它是**改写结果**的一种，
 *     落库时这样的项被丢掉（`promoteRecipe` 事务的第 ④ 步：不做的食材就不在清单里），
 *     所以库里也从不存「确认不放」这个状态。
 *
 * 三条硬约束（都在下面的 Zod 与 `validateRewrite` 里落成代码）：
 *   * 食材清单必须**原样覆盖**输入的那几项（名字一字不差、不增不减）——「不放蒜」的合法表达是
 *     `{"name":"蒜","grams":0}`，不是把这一项删掉（删掉之后「原来有没有蒜」就追溯不到了，
 *     校验层也少了一个「重标成了 0」与「漏改」的区分点）；
 *   * **至少一项正数**：全部是 0 的改写等于把菜谱改空（份量引擎会算出 0 g 的买菜清单）；
 *   * **待重标项（输入 0 克）必须被重标成正数**：转正会把克数固化成家庭基准，
 *     把一个 0 留着转正就是把「未定」写死成「没有」（台账「归属 #19」那条的收口）。
 */

/** 改了 prompt 措辞或输入形状就 +1（留痕里的版本号，历史转正靠它对回当时的模板） */
export const PROMOTION_PROMPT_VERSION = '2026-09-promotion-v1';

/** 输入里的「待转正菜谱」机器可读标记（fake 与测试靠它从 prompt 里读回输入，见 `pickPromotionRewrite`） */
export const PROMOTION_MARK = '【待转正菜谱】';
/** 输入里的「掌勺者口述差异」标记 */
export const DIFFERENCES_MARK = '【掌勺者口述差异】';

/** 一次改写的输入（域层从库里现读，不落任何缓存） */
export interface PromotionRequest {
  recipe: Recipe;
  /** 掌勺者口述的差异原文（可空串：没口述也要改写——待重标项仍要重标） */
  differences: string;
  /** 掌勺者在这次转正里校对过的菜系（有值就压过 LLM 的判断，见 `promoteRecipe` 的 `cuisineTo`） */
  cuisine?: RecipeCuisine;
}

/** 模型给出的改写（**未过滤**：菜系值域、食材集合、0 克项还要过 `validateRewrite`） */
export interface PromotionRewrite {
  kind: RecipeKind;
  effort: RecipeEffort;
  tastes: string[];
  cuisine?: string;
  seasonMonths?: number[];
  steps?: string;
  ingredients: { name: string; grams: number }[];
}

const PROMOTION_SCHEMA = z.object({
  kind: z.enum(['meat', 'veg', 'soup_meat', 'soup_veg']),
  effort: z.enum(['quick', 'medium', 'heavy']),
  /** 口味标签（值域在 `validateRewrite` 里按封闭五标签过滤，不在这里拒整条） */
  tastes: z.array(z.string().min(1)).default([]),
  cuisine: z.string().min(1).optional(),
  seasonMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  steps: z.string().optional(),
  ingredients: z
    .array(
      z.object({
        name: z.string().min(1),
        /**
         * 成人份克数：**0 是合法值**（「不放蒜」的显式表达），所以下界是 0 而不是 1；
         * 上界防幻觉（2000g 一个食材项已远超任何家常菜）。
         * 注意这是**改写出参**的语义：0 = 掌勺者口述确认不放，落库时该项被丢掉；
         * 与库里的 0（迁移 005：模糊份量待重标）是两种东西（见文件头「两种 0 不要混」）。
         */
        grams: z.number().min(0).max(2000),
      }),
    )
    .min(1, '食材清单不能为空'),
});

const SYSTEM_PROMPT = [
  '你是中国家庭的菜谱整理助手。掌勺者刚把一道**外部菜谱**（网上找来的做法）做成了一餐，',
  '现在要把它改写成「这家人的做法」，让它可以作为家庭菜谱长期使用。',
  '严格遵守：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
  '2. 食材清单必须**原样覆盖**输入的每一项：名字一字不差、不增不减、不合并同类项。',
  '   「不要某个食材」的表达是把它的 grams 写成 0（保留这一项），不是把它删掉。',
  '3. grams 是「一个成人一餐这道菜时的生重克数」，照输入的基准微调；不要 0 克——除非掌勺者',
  '   说了不要它。参考量：叶菜 150–250g、根茎 100–200g、肉 100–150g、鸡蛋 50–60g、',
  '   蒜 5–10g、姜 3–8g、盐 2–3g、生抽 10–15g、油 10–15g。',
  '4. 掌勺者口头说的差异（多点辣、不放蒜、少放盐…）就是这次的修改意图，必须落实在食材克数、',
  '   口味标签或难度上；他没提的部分保持原样，不要顺手改。',
  '5. 只能给了一个口味之外的**参考**菜系时用封闭集合：',
  `   ${CUISINES.join('、')}。跨菜系的家常做法给「家常」。`,
  '6. 克数拿不准就给中式家常的中间值，**不要给 0**（除了上面第 2 条说的「不要这个食材」）。',
  '输出 JSON 形状：',
  '{"kind":"veg","effort":"quick","tastes":["清淡"],"cuisine":"家常","seasonMonths":[5,6,7,8],',
  ' "steps":"<做法，可沿用输入>","ingredients":[{"name":"<原样>","grams":160}]}',
].join('\n');

export interface PromotionLlmOptions {
  /** 最多试几次（网络抖动重试 1 次；形状不合也重试 1 次） */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface PromotionOutcome {
  /** 校验通过的改写；undefined = 这次没改成（调用失败或形状不合） */
  rewrite?: PromotionRewrite;
  calls: number;
  /** 失败/丢弃的说明（进响应的 notes，不静默） */
  notes: string[];
  /** 最后一次成功调用的元数据（失败时 undefined——没有可写进台账的模型名） */
  model?: string;
  latencyMs: number;
}

/**
 * 让 LLM 把外部菜谱改写成家里版本（离线路径）。**失败返回 undefined 而不抛**：
 * 调用方（域层）据此拒绝整次转正（502），草稿原样留着让掌勺者重试——
 * 半截的改写比失败危险（见 `domain/promotion.ts`）。
 */
export async function rewriteRecipe(
  llm: LlmClient,
  request: PromotionRequest,
  options: PromotionLlmOptions = {},
): Promise<PromotionOutcome> {
  const prompt = buildPromotionPrompt(request);
  const system = SYSTEM_PROMPT;
  const maxAttempts = options.maxAttempts ?? 2;
  const notes: string[] = [];
  let calls = 0;
  let model: string | undefined;
  let latencyMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    calls += 1;
    try {
      const result = await llm.complete({
        system,
        prompt,
        responseFormat: 'json_object',
        timeoutMs: options.timeoutMs ?? 30_000,
        // 改写要的是**可比对的家里版本**，不是每次跑都变的菜谱（与导入同一个温度）
        temperature: 0.2,
      });
      model = result.model;
      latencyMs += result.latencyMs;
      const parsed = PROMOTION_SCHEMA.safeParse(parseJson(result.text));
      if (!parsed.success) {
        notes.push(`改写出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
        continue;
      }
      const checked = validateRewrite(parsed.data, request);
      if (!checked.ok) {
        notes.push(checked.reason);
        continue;
      }
      return { rewrite: checked.rewrite, calls, notes, model, latencyMs };
    } catch (cause) {
      const reason = cause instanceof LlmCallError ? cause.message : String(cause);
      notes.push(`改写第 ${calls} 次调用失败：${reason}`);
    }
  }

  return { rewrite: undefined, calls, notes, latencyMs: 0 };
}

/** prompt 的正文：整份菜谱（含份量原文证据）+ 掌勺者口述差异 */
export function buildPromotionPrompt(request: PromotionRequest): string {
  const { recipe } = request;
  const lines = [
    `${PROMOTION_MARK}`,
    JSON.stringify({
      id: recipe.id,
      name: recipe.name,
      kind: recipe.kind,
      effort: recipe.effort,
      cuisine: recipe.cuisine,
      tastes: recipe.tastes,
      seasonMonths: recipe.seasonMonths,
      steps: recipe.steps,
      // 份量一起给：模型据此判断「原来多少、该改多少」。`quantity` 是采集到的份量原文
      // （「两勺」「适量」）——它是重标的证据（纪律 2），转正时的「多点辣」也要落在同一批项上。
      // 注意 `recipe.ingredients` 的克数 0 = 待重标（迁移 005），提示词里如实呈现，模型必须给正数。
      ingredients: recipe.ingredients.map((item) => ({
        name: item.name,
        grams: item.adultGrams,
        scaling: item.scaling,
      })),
    }),
    '',
    `${DIFFERENCES_MARK}`,
    request.differences.trim() === '' ? '（掌勺者没说差异：照原菜谱整理成家常版本即可）' : request.differences.trim(),
  ];
  if (request.cuisine) {
    lines.push('', `掌勺者把菜系校对成：${request.cuisine}（以他的判断为准）。`);
  }
  lines.push('', '请输出改写后的 JSON。');
  return lines.join('\n');
}

type ValidateResult = { ok: true; rewrite: PromotionRewrite } | { ok: false; reason: string };

/**
 * 改写结果的**业务校验**（Zod 之外的那一层，全部是「宁可失败也不写坏库」）：
 *   * 食材名单必须与输入**集合相等**（一字不差、不增不减）——名字改了就对不回原来的食材字典项；
 *   * 至少一项正数（全 0 = 把菜谱改空）；
 *   * 输入里 0 克的项（待重标）必须变成正数——转正会把克数固化成家庭基准
 *     （唯一的例外是掌勺者口述明确说了不要它，见下面那条注释）；
 *   * 口味只收封闭五标签（多给/乱给就丢掉，不因此拒整条）；
 *   * 菜系必须在白名单里（不在就丢，让掌勺者的校对值或原值兜底）。
 */
export function validateRewrite(raw: PromotionRewrite, request: PromotionRequest): ValidateResult {
  const expected = new Set(request.recipe.ingredients.map((item) => item.name));
  const got = new Set<string>();
  for (const item of raw.ingredients) {
    if (!expected.has(item.name)) return { ok: false, reason: `改写里出现了输入没有的食材：${item.name}` };
    if (got.has(item.name)) return { ok: false, reason: `改写里同一个食材给了两次：${item.name}` };
    got.add(item.name);
  }
  for (const name of expected) {
    if (!got.has(name)) return { ok: false, reason: `改写漏掉了原有的食材：${name}` };
  }
  if (raw.ingredients.every((item) => item.grams <= 0)) {
    return { ok: false, reason: '改写把所有食材都写成了 0 克（这份菜谱会变成空壳）' };
  }
  // 待重标项必须被重标：这是 #19 台账点名留给转正的收口。
  // 库里 0 的**唯一**含义是「待重标」（迁移 005），所以「还是 0」= 没重标 = 拒绝。
  // 唯一的例外是掌勺者**明确说了不要它**（「不放蒜」）——那是「重标成了 0」这个**结论**，
  // 与「还没重标」是两种语义，靠口述原文区分。这个 0 只活在出参里：
  // 落库时这样的项会被 `promoteRecipe` 丢掉（库里不存「确认不放」）。
  const pending = request.recipe.ingredients.filter((item) => item.adultGrams <= 0).map((item) => item.name);
  const zero = new Set(raw.ingredients.filter((item) => item.grams <= 0).map((item) => item.name));
  const missed = pending.filter((name) => zero.has(name) && !droppedByDictation(request.differences, name));
  if (missed.length > 0) {
    return { ok: false, reason: `待重标的食材被改写成了 0 克（转正前必须先重标）：${missed.join('、')}` };
  }

  const allowedTastes = new Set(['甜', '辣', '酸', '咸鲜', '清淡']);
  const allowedCuisines = new Set<string>(CUISINES);
  return {
    ok: true,
    rewrite: {
      kind: raw.kind,
      effort: raw.effort,
      tastes: raw.tastes.filter((taste) => allowedTastes.has(taste)),
      cuisine: raw.cuisine && allowedCuisines.has(raw.cuisine) ? raw.cuisine : undefined,
      seasonMonths: raw.seasonMonths,
      steps: raw.steps,
      ingredients: raw.ingredients.map((item) => ({ name: item.name, grams: item.grams })),
    },
  };
}

/**
 * 从 prompt 里确定性地产出一份合法改写。**测试与 E2E 的 fake 用它**——与
 * `pickLlmSelection` 同一理由：E2E 不能依赖真模型（不确定、要钱、要网），
 * 而它要验的是**管线**（差异怎么落在克数上、状态怎么迁移、推荐池怎么即时生效）。
 *
 * 它必须只看 prompt 本身（不看闭包外的状态），这样「LLM 收到什么 → 回什么」在断言里可复现。
 * 规则刻意简单可预期（这就是「fake 的语义」）：
 *   * 待重标项（输入 0 克）→ 给一个中间值；
 *   * 「不放 X」/「不要 X」/「去 X」→ 该项 grams = 0（X 按名字包含匹配）；
 *   * 「多放 X」/「多点 X」→ 该项 ×1.5；「少放 X」/「少点 X」→ 该项 ×0.5；
 *   * 「多点辣」→ 补上「辣」标签；「清淡点」→ 补「清淡」；
 *   * 其余原样保留（kind / effort / 菜系 / 步骤）。
 */
export function pickPromotionRewrite(prompt: string): string | undefined {
  const input = parsePromotionInput(prompt);
  if (!input) return undefined;

  const differences = sectionAfter(prompt, DIFFERENCES_MARK) ?? '';
  const drop = dropMentions(differences);
  const more = matchMentions(differences, ['多放', '多点', '多来点', '加']);
  const less = matchMentions(differences, ['少放', '少点']);

  const tastes = new Set(input.tastes);
  if (/辣/.test(differences)) tastes.add('辣');
  if (/清淡/.test(differences)) tastes.add('清淡');
  if (/咸/.test(differences) && /多|重/.test(differences)) tastes.add('咸鲜');

  const ingredients = input.ingredients.map((item) => {
    let grams = item.grams;
    if (grams <= 0) grams = fallbackGrams(item.name);
    if (drop.some((word) => item.name.includes(word))) return { name: item.name, grams: 0 };
    if (more.some((word) => item.name.includes(word))) grams = round1(grams * 1.5);
    if (less.some((word) => item.name.includes(word))) grams = round1(grams * 0.5);
    return { name: item.name, grams };
  });

  return JSON.stringify({
    kind: input.kind,
    effort: input.effort,
    tastes: [...tastes],
    cuisine: input.cuisine ?? undefined,
    seasonMonths: input.seasonMonths.length > 0 ? input.seasonMonths : undefined,
    steps: input.steps,
    ingredients,
  });
}

/** prompt 里的【待转正菜谱】段形状（fake 与测试读它） */
interface PromptPromotionInput {
  kind: RecipeKind;
  effort: RecipeEffort;
  cuisine: RecipeCuisine | null;
  tastes: string[];
  seasonMonths: number[];
  steps: string;
  ingredients: { name: string; grams: number }[];
}

function parsePromotionInput(prompt: string): PromptPromotionInput | undefined {
  const block = sectionAfter(prompt, PROMOTION_MARK);
  if (!block) return undefined;
  try {
    const raw = JSON.parse(block) as PromptPromotionInput;
    if (!Array.isArray(raw.ingredients) || raw.ingredients.length === 0) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** 「不放 / 不要 / 去掉」这类说法的前缀（校验层与 fake 共用一处，免得两边漂移） */
const DROP_PREFIXES = ['不放', '不要', '不加', '不吃', '去掉', '别放'];

/** 掌勺者是否明确说了不要这个食材（按名字包含匹配：「不放蒜」命中「蒜」） */
export function droppedByDictation(differences: string, name: string): boolean {
  return dropMentions(differences).some((word) => name.includes(word));
}

function dropMentions(differences: string): string[] {
  return matchMentions(differences, DROP_PREFIXES);
}

/** 口述里「不放X」这类说法的 X：按食材名包含匹配（「不放蒜」命中「蒜」「蒜末」） */
function matchMentions(differences: string, prefixes: string[]): string[] {
  const mentions: string[] = [];
  for (const prefix of prefixes) {
    const pattern = new RegExp(`${prefix}([\\u4e00-\\u9fa5A-Za-z0-9]+)`, 'g');
    for (const match of differences.matchAll(pattern)) {
      if (match[1]) mentions.push(cleanMention(match[1]));
    }
  }
  return mentions;
}

/**
 * 把「加点**点**辣椒」「多放**点**蒜」里那层量词剥掉（fake 的容错，不是语言学工作）：
 * 剥完才有机会与食材名对上（「点辣椒」对不上「辣椒」）。
 */
function cleanMention(word: string): string {
  return word.replace(/^[了点些大多]+/, '').replace(/[，。、；,.]$/, '');
}

/** 待重标项的兜底克数：按名字给一个家常中间值（fake 的「重标」就是这个语义） */
function fallbackGrams(name: string): number {
  if (/盐|糖|醋|生抽|老抽|油/.test(name)) return 8;
  if (/蒜|姜|葱|椒/.test(name)) return 6;
  if (/蛋/.test(name)) return 55;
  if (/肉|排骨|鸡|鱼|虾|豆腐/.test(name)) return 120;
  return 100;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** JSON.parse 前的清洗：剥掉 markdown 代码块（与导入同一条，端点偶尔仍会包） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return undefined;
  }
}
