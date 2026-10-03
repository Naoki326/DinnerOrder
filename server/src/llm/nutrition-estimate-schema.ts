import { z } from 'zod';
import { LlmCallError, type LlmClient } from './types.js';
import { sectionAfter, stripCodeFence } from './prompt.js';
import type { IngredientRef } from '../wire-types.js';

/**
 * **估算营养**的 LLM 出参形状（CONTEXT「估算营养」；ADR-0013；issue #38）。
 *
 * 一句话：录一条**新食材**时，字典里没有《中国食物成分表》读数，让 LLM 给四项营养
 * （能量 kcal / 蛋白质 / 脂肪 / 碳水，每 100 g 可食部）的**估算值**，预填进录入表单，
 * 掌勺者看一眼、改一改、**确认才落库**。
 *
 * 与另外几条 LLM 路径的分工（别混）：
 *   * `contains-suggestion-schema.ts`（#37）：「这条复合调料可能含什么」——产出是**忌口指针**；
 *   * `import-schema.ts`（#19）/ `promotion-schema.ts`（#21）/ `import-structure.ts`（#32）：
 *     份量与菜谱内容的改写与重标——都在**菜谱**这一侧；
 *   * 本模块：**食材**的四项营养读数。它是 ADR-0013 明确记下的「对 ADR-0004 的部分修正」
 *     ——估算值**进营养合计**（ADR-0004 的「LLM 不进数值路径」在这条上松动了，见 ADR-0013）。
 *     **ADR-0004 没被碰的那一半照旧**：份量（克数）一个 LLM 数字都不进。
 *
 * 四条本模块特有的纪律：
 *
 * 1. **数字可以是模型给的，但「参照了哪条成分表条目」必须落在池子里**。ADR-0013 允许估算，
 *    所以这里不要求「只选不生成」（那是「含」提议的纪律）；但落库行的 `source` 要写
 *    「参照 <最接近的成分表条目>」——若那个食物名是模型编的，这一行的出处就成了**假证据**。
 *    所以参照条目对不上池子 → **整条不可用**（`resolveNutritionEstimate` 返回 undefined），
 *    重试后降级。这与「含」提议的「越界丢该条、剩下的照收」不同：那边的产出是一个建议列表，
 *    丢一条对人无害；这边是**一行的全部内容**，参照没了就整行没了。
 * 2. **降级与「估不出来」分得开**（ADR-0013 与 ADR-0012「降级必须可区分」同一条）：
 *    `degraded: true` = AI 这次用不了（调用失败 / 产出一直不可信）；
 *    `estimate: undefined` + `degraded: false` = AI 看过了、这条估不出来。
 *    界面据此说两句不同的话（「AI 暂时用不了，你先自己填」vs「AI 也拿不准，你自己填」）。
 * 3. **预填而非写入**：本模块一个字节都不落库。落库走 `POST /api/ingredients` 的 `nutrition`
 *    字段（人确认之后），见 `domain/ingredient-nutrition.ts`。
 * 4. **池子空就不必问**：字典里一条成分表读数都没有时，没有任何可参照的东西，
 *    答案恒为「估不出来」——这时它是 `degraded: false`（与 AI 健康状况无关）。
 */

/** 输入里的「待估算营养的食材」标记（fake 与测试靠它从 prompt 里读回输入） */
export const NUTRITION_MARK = '【待估算营养的食材】';
/** 输入里的「可参照的成分表条目」标记（池子；参照条目的越界校验就对着它做） */
export const NUTRITION_REFERENCE_MARK = '【可参照的成分表条目】';

/**
 * E2E 的确定性探针：名字含「估不出」时，fake 回 `{"estimate":null}`——
 * 页面层的「AI 看过了但估不出来 → 四项留空、不拦保存」这条靠它可验（E2E 服务端只有一个共享的
 * fake，没有「单个用例临时编程 fake」的口子，所以探针只能从**输入**里给，
 * 与 `CONTAINS_OUT_OF_POOL_PROBE` 同一思路）。
 */
export const NUTRITION_NO_ESTIMATE_PROBE = '估不出';

/**
 * 估算行的固定前缀（ADR-0013「决定一」：判定「是不是估算行」靠 `source` 的固定前缀，
 * **不靠新列、也不靠第二张表**）。写在一处，读的人也走 `isEstimatedNutritionSource`。
 */
export const ESTIMATED_SOURCE_PREFIX = 'LLM 估算';

/** 可参照的一条成分表读数（每 100 g 可食部）——池子条目的形状 */
export interface NutritionReference {
  ingredientId: string;
  /** 成分表里的食物名（如「酱油(均值)」）：它会写进估算行的 source，供人回查 */
  name: string;
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

/** 一次估算的输入：待估算的食材名 + 可参照的成分表条目（**由调用方从库里现读**） */
export interface NutritionEstimateRequest {
  /** 待估算的食材规范名（新建时表单里刚敲的名字） */
  name: string;
  /**
   * 池子：**已经有成分表读数**的条目（四项齐全）。本模块不认识数据库，
   * 也无法凭空知道成分表里有什么——池子必须由调用方现读。
   */
  references: NutritionReference[];
}

/** 一次估算的产出（四项 + 参照条目） */
export interface NutritionEstimate {
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /** 参照的成分表条目（**池内条目**：id + 成分表食物名） */
  reference: IngredientRef;
}

/** 模型给出的原始出参（**未校验**：四项非负有限、参照条目还要过池内校验） */
interface RawNutritionEstimate {
  energyKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /** 参照的成分表食物名（提示词里要求原样照抄池子里的 name） */
  reference: string;
}

/**
 * 出参形状：`{"estimate": {...}}` 或 `{"estimate": null}`。
 *
 * `estimate` **必须存在**（缺字段 → 形状不合 → 重试）：`null` 是「估不出来」的合法答案，
 * 而「忘了给这个字段」是模型的走样——两者要分得开（前者是结论，后者是没答）。
 */
const NUTRITION_SCHEMA = z.object({
  estimate: z
    .object({
      // 四项都非负且有限：负数与 Infinity/NaN 都不是营养读数（NaN 过不了 zod 的 number）
      energyKcal: z.number().finite().min(0).max(1000),
      proteinG: z.number().finite().min(0).max(100),
      fatG: z.number().finite().min(0).max(100),
      carbG: z.number().finite().min(0).max(100),
      reference: z.string().trim().min(1),
    })
    .nullable(),
});

const SYSTEM_PROMPT = [
  '你是中国家庭的食材营养助手。任务：给一条**字典里还没有成分表读数**的食材，估算它的四项营养',
  '（每 100 g 可食部）：能量 kcal、蛋白质 g、脂肪 g、碳水 g。',
  '严格遵守：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
  '2. 先从【可参照的成分表条目】里挑**最接近**的那一条，然后在它的读数基础上按这条食材的实际',
  '   情况调整（如蚝油比酱油含糖更多、香料以干重计）。**不得凭空给出一个池子外的食物名当参照**。',
  '3. reference 必须与池子里的某个 name 一字不差。',
  '4. 这四项会**标为估算值**进营养合计，所以宁可保守，不要为了好看而虚报。',
  '5. 实在估不出来就回 {"estimate":null}（合法答案，不要编一个数来凑）。',
  '输出 JSON 形状：',
  '{"estimate":{"energyKcal":64,"proteinG":5.6,"fatG":0.1,"carbG":10.1,"reference":"<池子里的 name>"}}',
].join('\n');

export interface NutritionLlmOptions {
  /** 最多试几次（网络抖动重试 1 次；形状不合或参照越界也重试 1 次） */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface NutritionEstimateOutcome {
  /** 校验通过的估算；undefined = 这次没估出来（见 `degraded`） */
  estimate?: NutritionEstimate;
  /**
   * 这一次是不是「AI 用不了」（调用失败，或产出一直不可信）。
   * `degraded: true` 时 `estimate` 恒为 undefined——降级不是失败，但界面必须能把它说出来。
   */
  degraded: boolean;
  calls: number;
  /** 失败/丢弃的说明（不静默；本项不落库，只用于排查） */
  notes: string[];
  /** 成功时给出模型名（落库行的 source 要写上它，ADR-0013 决定一） */
  model?: string;
}

/**
 * 让 LLM 估一条食材的四项营养（离线路径，人点一下才跑一次）。**失败不抛**：
 * 降级成 `degraded: true` + 无估算，由路由照 200 返回——手填这条路永远不受影响。
 */
export async function estimateNutrition(
  llm: LlmClient,
  request: NutritionEstimateRequest,
  options: NutritionLlmOptions = {},
): Promise<NutritionEstimateOutcome> {
  // 池子空就不必问（见文件头第 4 条）：没有可参照的读数，答案与 AI 健康状况无关。
  if (request.references.length === 0) {
    return { degraded: false, calls: 0, notes: ['字典里没有可参照的成分表条目，没有可挑选的池子'] };
  }

  const prompt = buildNutritionPrompt(request);
  const maxAttempts = options.maxAttempts ?? 2;
  const notes: string[] = [];
  let calls = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    calls += 1;
    try {
      const result = await llm.complete({
        system: SYSTEM_PROMPT,
        prompt,
        responseFormat: 'json_object',
        timeoutMs: options.timeoutMs ?? 15_000,
        // 估算要的是「同一条食材每次给出同一份预填」可比对的东西，不是每次跑都变的灵感
        temperature: 0.2,
      });
      const parsed = NUTRITION_SCHEMA.safeParse(parseJson(result.text));
      if (!parsed.success) {
        notes.push(`估算营养出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
        continue;
      }
      // 估不出来是合法答案（degraded: false）——它不是降级，界面说「AI 也拿不准」
      if (parsed.data.estimate === null) {
        return { degraded: false, calls, notes: [...notes, 'AI 看过了，这条估不出来'] };
      }
      const estimate = resolveNutritionEstimate(parsed.data.estimate, request.references);
      if (!estimate) {
        notes.push(`参照的成分表条目不在池子里（${parsed.data.estimate.reference}）——整条不可用`);
        continue;
      }
      return { estimate, degraded: false, calls, notes, model: result.model };
    } catch (cause) {
      const reason = cause instanceof LlmCallError ? cause.message : String(cause);
      notes.push(`估算营养第 ${calls} 次调用失败：${reason}`);
    }
  }

  // 两次都没给出可用产出 → 降级（不是失败）：无估算 + degraded，让界面说「AI 暂时用不了」
  return { degraded: true, calls, notes };
}

/**
 * prompt 的正文：待估算的名字 + 可参照的成分表条目（带数字的紧凑 JSON）。
 *
 * 池子条目给 id + name + **四项读数**：模型要先挑最接近的那条、再在它基础上调整，
 * 不给数字就只剩「凭空猜」（那正是 012「宁可缺失也不编数」要防的）。
 */
export function buildNutritionPrompt(request: NutritionEstimateRequest): string {
  return [
    `${NUTRITION_MARK}`,
    request.name,
    '',
    `${NUTRITION_REFERENCE_MARK}`,
    JSON.stringify(
      request.references.map((entry) => ({
        id: entry.ingredientId,
        name: entry.name,
        energyKcal: entry.energyKcal,
        proteinG: entry.proteinG,
        fatG: entry.fatG,
        carbG: entry.carbG,
      })),
    ),
    '',
    '请估算这条食材每 100 g 可食部的四项营养，并给出你参照的池内条目名，只输出 JSON。',
  ].join('\n');
}

/**
 * 校验一条原始估算：四项非负有限，且**参照条目落在池子里**（按名字或 id 对上）。
 * 对不上就返回 undefined——整条不可用（见文件头第 1 条），不静默换一个参照。
 */
export function resolveNutritionEstimate(
  raw: RawNutritionEstimate,
  references: NutritionReference[],
): NutritionEstimate | undefined {
  const values = [raw.energyKcal, raw.proteinG, raw.fatG, raw.carbG];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;

  const wanted = raw.reference?.trim() ?? '';
  const reference =
    references.find((entry) => entry.name === wanted) ?? references.find((entry) => entry.ingredientId === wanted);
  if (!reference) return undefined;

  return {
    energyKcal: raw.energyKcal,
    proteinG: raw.proteinG,
    fatG: raw.fatG,
    carbG: raw.carbG,
    reference: { ingredientId: reference.ingredientId, name: reference.name },
  };
}

/**
 * 估算行的 `source`（ADR-0013「决定一」）：**必须自证是估算**，且带模型标识与参照的成分表条目。
 *
 * 形态与 012 的逐行出处纪律同构（那一列是「哪个平台的哪个食物名、原始数值」）：
 * 这里写清「这是估算、哪个模型估的、参照的是哪条读数」——三者齐了，人才回查得到。
 *
 * **纯文本，不带 markdown 标记**：它会原样渲染给用户看（详情卡、营养弹层），
 * 星号会以字面形式显示出来（同 `NUTRITION_SOURCE_NOTE` 那条注记的纪律）。
 */
export function estimatedNutritionSource(model: string, reference: IngredientRef): string {
  return (
    `${ESTIMATED_SOURCE_PREFIX}（模型 ${model}）：参照《中国食物成分表》「${reference.name}」的读数，` +
    `由模型按这条食材的情况调整，每 100 g 可食部；这是估算值，不是成分表读数`
  );
}

/** 这一行的 source 是不是估算行（判定只有这一处：固定前缀，不靠新列） */
export function isEstimatedNutritionSource(source: string): boolean {
  return source.trimStart().startsWith(ESTIMATED_SOURCE_PREFIX);
}

/**
 * 从 prompt 里确定性地产出一份估算。**测试与 E2E 的 fake 用它**——与 `pickContainsSuggestion`
 * 同一理由：E2E 不能依赖真模型，而它要验的是管线（池子怎么进 prompt、参照越界怎么被拦、
 * 降级怎么被说出来）。它必须只看 prompt 本身，这样「LLM 收到什么 → 回什么」在断言里可复现。
 *
 * 规则刻意简单可预期（这就是「fake 的语义」）：
 *   * 按食材名的关键词在池子里找最接近的一条（蚝油 → 名字含「酱油/豆」的条目）；
 *   * 认不出就用**池子第一条**（确定性，不随机）；
 *   * **数字照抄那一条的读数**（可复算：界面上的预填值必然等于某条真读数）；
 *   * 名字含探针词「估不出」→ `{"estimate":null}`。
 */
export function pickNutritionEstimate(prompt: string): string | undefined {
  const name = sectionAfter(prompt, NUTRITION_MARK);
  const references = parseNutritionReferences(prompt);
  if (name === undefined || references.length === 0) return undefined;

  if (name.includes(NUTRITION_NO_ESTIMATE_PROBE)) return JSON.stringify({ estimate: null });

  const reference = pickReference(name, references);
  return JSON.stringify({
    estimate: {
      energyKcal: reference.energyKcal,
      proteinG: reference.proteinG,
      fatG: reference.fatG,
      carbG: reference.carbG,
      reference: reference.name,
    },
  });
}

/** 食材名 → 池子里最接近的那条（fake 的简单启发式；命中就取第一条，认不出就取池子第一条） */
function pickReference(name: string, references: NutritionReference[]): NutritionReference {
  for (const [pattern, hints] of NUTRITION_HINTS) {
    if (!pattern.test(name)) continue;
    const matched = references.find((entry) => hints.some((hint) => entry.name.includes(hint)));
    if (matched) return matched;
  }
  return references[0]!;
}

/**
 * fake 的关键词表（测试基建，不是产品逻辑）：只回答「这个名字认得出、该往池子里找什么样的条目」。
 * 顺序有意义（先匹配到的规则生效），所以「蚝油」不会落到泛化的「酱油」规则上。
 */
const NUTRITION_HINTS: [RegExp, string[]][] = [
  [/蚝油|oyster/i, ['酱油']],
  [/豆瓣|豆酱|bean paste/i, ['辣椒', '豆']],
  [/芝麻酱|麻酱/i, ['芝麻']],
  [/芥末|mustard/i, ['芥末']],
  [/醋|vinegar/i, ['醋', '米']],
  [/糖|sugar/i, ['糖']],
  [/酒|wine|liquor/i, ['酒']],
  [/花椒|pepper/i, ['胡椒', '椒']],
];

/** prompt 里的【可参照的成分表条目】段形状（fake 与测试读它） */
function parseNutritionReferences(prompt: string): NutritionReference[] {
  const block = sectionAfter(prompt, NUTRITION_REFERENCE_MARK);
  if (!block) return [];
  try {
    const raw = JSON.parse(block) as {
      id: string;
      name: string;
      energyKcal: number;
      proteinG: number;
      fatG: number;
      carbG: number;
    }[];
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => ({
      ingredientId: entry.id,
      name: entry.name,
      energyKcal: entry.energyKcal,
      proteinG: entry.proteinG,
      fatG: entry.fatG,
      carbG: entry.carbG,
    }));
  } catch {
    return [];
  }
}

/** JSON.parse 前的清洗：剥掉 markdown 代码块（与其余几条 LLM 路径同一条） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    return undefined;
  }
}
