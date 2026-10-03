import { z } from 'zod';
import { LlmCallError, type LlmClient } from './types.js';
import { sectionAfter, stripCodeFence } from './prompt.js';
import type { IngredientRef } from '../wire-types.js';

/**
 * 「含」提议的 LLM 出参形状（CONTEXT「『含』提议」；ADR-0012「决定六」；issue #37）。
 *
 * 一句话：录/改一条**复合调料**时（蚝油、豆瓣酱…），让 LLM 给一条「这条可能含某食材」的
 * **预填建议**（蚝油 → 贝类）；掌勺者确认才落库。它**只能从字典现有条目里挑目标**，
 * 不凭空生成食材名——ADR-0001「LLM 只从检索池中选、不自由生成」在食材上的原样复用
 * （**不是**对 ADR-0001 的修改，见 ADR-0012「决定六」）。
 *
 * 与 `promotion-schema.ts` 同一形态（先读它）：单次 `json_object` + Zod 校验 + 失败重试，
 * 出参是**预填而非写入**（本模块不碰库，落库与否由路由/界面决定）。
 *
 * 三条本模块特有的纪律：
 *
 * 1. **不是候选池里的目标一律丢掉，不报错**（`resolveContainsTargets`）：越界的名字**只丢该条**，
 *    同批里合法的照收；全是越界就等于「没有建议」。这与推荐/候选那条路不同——那边越界是
 *    **整条失败**（`checkSelection` / `checkCandidates` 直接判失败），因为一整餐/一整套候选
 *    少一道就配不满；而「含」提议是一个建议列表，丢掉不可信的那条、留下可信的，
 *    对人没有坏处，也不会写坏库。**但绝不能因为丢了几条就把整次结果说成降级**。
 * 2. **降级必须可区分**（ADR-0012「降级必须可区分」）：LLM 用不了时返回 `degraded: true` +
 *    空数组，而**不是**「没有建议」（那要 `degraded: false` + 空数组）。这个字段存在的全部意义
 *    就是让界面把「AI 这次用不了」与「AI 看过了、没有建议」说成两句不同的话——
 *    把一次故障说成「这东西确实不含什么」是错的，而这条信息的读众是**忌口硬过滤**。
 * 3. **池子空就不必问**（`suggestContains` 的第一行）：字典里连一条可挂的基础条目都没有时，
 *    LLM 无从挑选，答案恒为「没有可挂的目标」。这时它是 `degraded: false`——
 *    「字典里没有」是一个与 AI 健康状况无关的事实，把它标成降级会掩盖真正要人做的动作
 *    （先去建「贝类」那一条）。
 */

/** 输入里的「待建议的复合调料」名称标记（fake 与测试靠它从 prompt 里读回输入） */
export const CONTAINS_MARK = '【待建议的复合调料】';
/** 输入里的「可挂的食材池」标记（字典现有条目；越界校验就对着它做） */
export const CONTAINS_POOL_MARK = '【可挂的食材池】';

/**
 * E2E 的确定性探针：提示词里的名称含「越界」时，fake 会**额外吐一个字典外的名字**
 * （见 `pickContainsSuggestion`）。页面层的「越界被拦下」这条 AC 靠它可验——
 * E2E 服务端只有一个共享的 fake，没有「单个用例临时编程 fake」的口子（见 `e2e-server.ts`），
 * 所以探针只能从**输入**里给（与 `pickPromotionRewrite` 从 prompt 里读口述差异同一思路）。
 */
export const CONTAINS_OUT_OF_POOL_PROBE = '字典里没有这条食材';

/** 一次提议的输入：待建议的那条（名称）+ 可挂的候选池（**字典现有条目**） */
export interface ContainsSuggestionRequest {
  /** 待建议的复合调料规范名（新建时刚敲的名字 / 修订时当前条目的名字） */
  name: string;
  /**
   * 候选池：字典现有条目（id + 规范名）。**必须由调用方从字典现读**——
   * 本模块不认识数据库，也无法凭空知道字典里有什么。
   */
  pool: IngredientRef[];
}

/** 模型给出的目标（**未过滤**：逐个过 `resolveContainsTargets` 的池内校验） */
interface RawContainsTarget {
  name: string;
  id?: string;
}

const CONTAINS_SCHEMA = z.object({
  /**
   * `targets` **必须是数组**（缺字段/给字符串都是形状不合 → 重试；重试仍不合 = 降级）。
   * 空数组是合法答案：它的含义是「AI 看过了，没有建议」（配合 `degraded: false`）。
   */
  targets: z.array(
    z.object({
      /** 规范名（提示词里要求原样照抄候选池里的名字） */
      name: z.string().trim().min(1),
      /** 也收 id：模型偶尔会更愿意抄 id，能对上池子就同样算数 */
      id: z.string().min(1).optional(),
    }),
  ),
});

const SYSTEM_PROMPT = [
  '你是中国家庭的食材字典助手。任务：判断一条**复合调料**（蚝油、豆瓣酱、沙茶酱…）可能含有',
  '哪些基础食材，供掌勺者确认后挂成隐性忌口「含」指针。',
  '严格遵守：',
  '1. 只输出 JSON，不要 markdown 代码块，不要解释文字。',
  '2. **只能从【可挂的食材池】里挑**，名字必须与池子里的 name 一字不差；不得创造池子里没有的食材名。',
  '3. 拿不准就少给或不给（空数组是合法答案）。宁可漏，也不要编一个字典里没有的条目。',
  '4. 不需要考虑它本身的加工方式（发酵/熬煮不影响「含」）。',
  '输出 JSON 形状：{"targets":[{"name":"<池子里的 name>"}]}',
].join('\n');

export interface ContainsLlmOptions {
  /** 最多试几次（网络抖动重试 1 次；形状不合也重试 1 次） */
  maxAttempts?: number;
  timeoutMs?: number;
}

export interface ContainsSuggestionOutcome {
  /** 校验通过的池内目标（可能为空：AI 看过了、没有建议 / 给的全是池外） */
  targets: IngredientRef[];
  /**
   * 这一次是不是「AI 用不了」（调用失败或形状一直不合）。
   * `degraded: true` 时 `targets` 恒为空——降级不是失败，但界面必须能把它说出来。
   */
  degraded: boolean;
  calls: number;
  /** 失败/丢弃的说明（不静默；本项不落库，只用于排查） */
  notes: string[];
}

/**
 * 让 LLM 给一条「含」提议（离线路径，人点一下才跑一次）。**失败不抛**：
 * 降级成 `degraded: true` + 空目标，由路由照 200 返回——手填这条路永远不受影响。
 */
export async function suggestContains(
  llm: LlmClient,
  request: ContainsSuggestionRequest,
  options: ContainsLlmOptions = {},
): Promise<ContainsSuggestionOutcome> {
  // 池子空就不必问（见文件头第 3 条）：没有可挑选的东西，答案与 AI 健康状况无关。
  if (request.pool.length === 0) {
    return { targets: [], degraded: false, calls: 0, notes: ['字典里没有可挂的目标，没有可挑选的池子'] };
  }

  const prompt = buildContainsPrompt(request);
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
        // 提议要的是「同一条调料每次给出同一批候选」可比对的东西，不是每次跑都变的灵感
        temperature: 0.2,
      });
      const parsed = CONTAINS_SCHEMA.safeParse(parseJson(result.text));
      if (!parsed.success) {
        notes.push(`「含」提议出参形状不合：${parsed.error.issues[0]?.message ?? '未知'}`);
        continue;
      }
      // 越界丢该条（**不报错、不落库**）：留下的都是字典里真有、且在这次池子里的条目
      const targets = resolveContainsTargets(parsed.data.targets, request.pool);
      const dropped = parsed.data.targets.length - targets.length;
      if (dropped > 0) notes.push(`丢弃了 ${dropped} 条字典外的目标（不返回、不落库）`);
      return { targets, degraded: false, calls, notes };
    } catch (cause) {
      const reason = cause instanceof LlmCallError ? cause.message : String(cause);
      notes.push(`「含」提议第 ${calls} 次调用失败：${reason}`);
    }
  }

  // 两次都没给出可用形状 → 降级（不是失败）：空目标 + degraded，让界面说「AI 暂时用不了」
  return { targets: [], degraded: true, calls, notes };
}

/**
 * prompt 的正文：待建议的名字 + 可挂的候选池（紧凑 JSON）。
 *
 * 池子条目给 id + name：模型抄 name，id 是给「它想抄 id」时的兜底（`resolveContainsTargets`
 * 两种都能对上）。**只给这两个字段**——别名/时令/「含」与这次判断无关，给多了只增加幻觉面。
 */
export function buildContainsPrompt(request: ContainsSuggestionRequest): string {
  return [
    `${CONTAINS_MARK}`,
    request.name,
    '',
    `${CONTAINS_POOL_MARK}`,
    JSON.stringify(request.pool.map((entry) => ({ id: entry.ingredientId, name: entry.name }))),
    '',
    '请判断这条复合调料可能含有【可挂的食材池】里的哪几样，只输出 JSON。',
  ].join('\n');
}

/**
 * 逐个目标做**池内校验**：对不上池子的**丢掉该条**（不报错、不落库），去重后保序。
 *
 * 与推荐/候选那两条路的差别是有意的（见文件头第 1 条）：那边越界 = 整次失败（配不满）；
 * 这边越界 = 丢该条，剩下的照用。识别方式两种：池内 id 命中，或规范名一字不差命中。
 */
export function resolveContainsTargets(raw: RawContainsTarget[], pool: IngredientRef[]): IngredientRef[] {
  const byId = new Map(pool.map((entry) => [entry.ingredientId, entry]));
  const byName = new Map(pool.map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  const result: IngredientRef[] = [];
  for (const item of raw) {
    const entry = (item.id ? byId.get(item.id) : undefined) ?? byName.get(item.name);
    if (!entry) continue; // 字典外：丢这条
    if (seen.has(entry.ingredientId)) continue; // 同一条给两次：去重
    seen.add(entry.ingredientId);
    result.push(entry);
  }
  return result;
}

/**
 * 从 prompt 里确定性地产出一份「含」建议。**测试与 E2E 的 fake 用它**——与
 * `pickPromotionRewrite` 同一理由：E2E 不能依赖真模型，而它要验的是管线
 * （候选池怎么进 prompt、越界怎么被拦、空结果怎么被说出来）。
 *
 * 它必须只看 prompt 本身（不看闭包外的状态），这样「LLM 收到什么 → 回什么」在断言里可复现。
 * 规则刻意简单可预期（这就是「fake 的语义」）：
 *   * 按调料名的关键词在池子里找几条（如「蚝油」→ 名字含「贝」的条目）；
 *   * 认不出的名字、或池子里没有对得上的条目 → **空数组**（「没有建议」的确定性样本）；
 *   * 名字含**探针词**「越界」时额外吐一条 `CONTAINS_OUT_OF_POOL_PROBE`（字典外）——
 *     专门给页面层验「越界被拦下」用。
 */
export function pickContainsSuggestion(prompt: string): string | undefined {
  const name = sectionAfter(prompt, CONTAINS_MARK);
  const pool = parseContainsPool(prompt);
  if (name === undefined || pool.length === 0) return undefined;

  const targets: RawContainsTarget[] = suggestByKeyword(name, pool).map((entry) => ({ name: entry.name }));
  // 探针：额外吐一个字典外的名字，页面层该把它拦下（不显示、不落库）
  if (name.includes('越界')) targets.push({ name: CONTAINS_OUT_OF_POOL_PROBE });

  return JSON.stringify({ targets });
}

/** 调料名 → 池子里可能有关系的条目（fake 的简单启发式；命中就取前几条，认不出就空） */
function suggestByKeyword(name: string, pool: IngredientRef[]): IngredientRef[] {
  for (const [pattern, hints] of CONTAINS_HINTS) {
    if (!pattern.test(name)) continue;
    const matched = pool.filter((entry) => hints.some((hint) => entry.name.includes(hint)));
    return matched.slice(0, MAX_SUGGESTIONS);
  }
  return [];
}

/**
 * fake 的关键词表（测试基建，不是产品逻辑）：只回答「这个名字认得出、该往池子里找什么样的条目」。
 * 顺序有意义（先匹配到的规则生效），所以「蚝油」不会落到泛化的「酱油」规则上。
 */
const CONTAINS_HINTS: [RegExp, string[]][] = [
  [/蚝油|oyster/i, ['贝']],
  [/豆瓣|bean paste|豆酱/i, ['辣椒', '豆']],
  [/沙茶|虾酱|鱼露|虾米/i, ['虾', '贝', '鱼']],
  [/生抽|老抽|酱油|soy/i, ['豆', '小麦', '麸']],
  [/豆豉/i, ['豆']],
  [/番茄酱|ketchup/i, ['番茄']],
  [/芝麻酱|麻酱/i, ['芝麻']],
  [/芥末|mustard/i, ['芥末']],
  [/醋|vinegar/i, ['米', '麦', '高粱']],
];

/** fake 一次最多给几条（与界面展示的量级相称，不是产品上限） */
const MAX_SUGGESTIONS = 3;

/** prompt 里的【可挂的食材池】段形状（fake 与测试读它） */
function parseContainsPool(prompt: string): IngredientRef[] {
  const block = sectionAfter(prompt, CONTAINS_POOL_MARK);
  if (!block) return [];
  try {
    const raw = JSON.parse(block) as { id: string; name: string }[];
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => ({ ingredientId: entry.id, name: entry.name }));
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
