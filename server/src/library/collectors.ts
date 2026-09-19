import { createHash } from 'node:crypto';
import type { DraftRecipe, RawIngredient } from '../domain/library.js';
import type { RecipeCuisine, RecipeKind, TasteTag } from '../wire-types.js';

/**
 * 冷启动导入的**采集侧**（总纲 §2.8、§5；ADR-0006）：把外部数据源读成 `DraftRecipe[]`。
 *
 * 三个采集器对应 ADR-0006 的三个来源，**共用同一条草稿管线**（本文件的产出都进
 * `domain/library.ts` 的 `importDrafts`）：
 *
 *   1. `parseHowToCook`：HowToCook（Anduin2017/HowToCook，**Unlicense 公有领域**）的 markdown。
 *      纯文本解析——测试跑在仓库内的 fixture 上，**不需要网络**（网络只在 `scripts/` 的
 *      采集脚本里，见 `import-library.ts`）。这样「导入器对不对」与「今天能不能连上 GitHub」
 *      是两件独立的事（网络断了测试照样全绿）。
 *   2. `parseXiachufangHtml`：下厨房热榜页（无开放许可，自家私用风险自知——ADR-0006 的决定），
 *      来源**如实**标 `scraped`。
 *   3. `llmGeneratedDraft`：LLM 生成的草稿，来源标 `llm`，走**同一个**落库管线。
 *
 * 三条纪律：
 *   * **筛选口径是「家常热度 + 忌口排除」，不按菜系**（§2.8、ADR-0006 明确否决了按菜系筛）。
 *     所以 `isHomeStyle` 看的是「家常做不做得到」，不看它是川菜还是粤菜；菜系只作参考 tag。
 *   * **不猜克数**：原文没有明确克数的项一律 `adultGrams: null`（等 LLM 重标），
 *     原文的份量文本（「两勺」「3 瓣」「适量」）留在 `quantity` 里当重标的输入与证据。
 *   * **做法步骤照抄原文**（自由文本，只给掌勺者参考、不进推荐管线，总纲 §2.8）。
 */

// ---------------------------------------------------------------- 通用小工具

/** 重量单位换算到克：斤/两/公斤/克/g/kg */
function gramsFrom(value: number, unit: string): number | undefined {
  switch (unit) {
    case '克':
    case 'g':
    case 'G':
    case '克左右':
      return value;
    case '斤':
      return value * 500;
    case '两':
      return value * 50;
    case '公斤':
    case 'kg':
    case 'KG':
      return value * 1000;
    case 'ml':
    case 'ML':
    case '毫升':
      // 体积不是重量：水/油/酱油按 1:1 近似（家常口径下的通行做法，报告里不装作精确）
      return value;
    default:
      return undefined;
  }
}

/**
 * 从原文的份量文本里抠出**明确**的克数。抠不出来就返回 undefined（→ 等 LLM 重标）。
 *
 * 「不猜」是这里的核心纪律：`3 瓣蒜` 不换算成 15g（那是重标的活），只有原文自己写了
 * 克/斤/公斤这类**重量单位**才算明确。体积（ml）折算成克是家常口径的近似，
 * 且只用于「本来就没克数」的项——原文给了克数就不动它。
 */
export function parseGrams(text: string): number | undefined {
  const normalized = text.replace(/[，,]/g, '').replace(/\s+/g, ' ').trim();
  // ① 明确的重量/体积单位：`200g` / `约 3~4 斤` / `250 毫升`
  const withUnit = /(\d+(?:\.\d+)?)\s*(?:[-~到至]\s*(\d+(?:\.\d+)?)\s*)?(公斤|千克|斤|两|克|毫升|kg|KG|ml|ML|g|G)/.exec(normalized);
  if (withUnit) {
    const value = Number.parseFloat(withUnit[2] ?? withUnit[1]!);
    const grams = gramsFrom(value, withUnit[3]!);
    if (grams !== undefined) return grams;
  }
  return undefined;
}

/** 模糊份量的字面（报告里要留证据：「这一项原文写的是适量」） */
const VAGUE_WORDS = ['适量', '少许', '若干', '些许', '酌量', '一点', '微小', '看情况', '按口味'];

export function isVagueQuantity(text: string): boolean {
  return VAGUE_WORDS.some((word) => text.includes(word));
}

/** 调料/香料：一锅就这么多，不随人数放大（`scaling='fixed'`，与 002 的种子同一口径） */
const SEASONING_WORDS = [
  '盐', '糖', '生抽', '老抽', '酱油', '醋', '蚝油', '料酒', '黄酒', '白酒', '油', '淀粉', '生粉',
  '豆瓣', '豆豉', '甜面酱', '黄豆酱', '番茄酱', '沙司', '香油', '芝麻油', '花椒', '八角', '桂皮',
  '香叶', '孜然', '五香粉', '十三香', '胡椒粉', '胡椒', '辣椒粉', '辣椒面', '鸡精', '味精', '酵母',
  '泡打粉', '蜂蜜', '咖喱', '高汤', '鸡汤', '水', '柠檬汁', '蒜', '姜', '葱', '香菜', '蒜末', '葱花',
  '姜片', '姜末', '干辣椒', '小米辣', '鸡粉', '芥末', '腐乳', '麻酱', '甜酱', '红糖', '冰糖', '白糖',
];

export function isSeasoning(name: string): boolean {
  return SEASONING_WORDS.some((word) => name.includes(word));
}

/**
 * 取 `## <标题>` 段落的正文（到下一个 **二级** 标题为止）。
 *
 * 不用一条正则一口气切：`([\s\S]*?)(?=^##\s|$)` 在 `/m` 下**看起来对、实际错**——
 * `$` 在多行模式下匹配的是「任意行尾」，于是段落只取到第一行（HowToCook 的 `## 操作`
 * 下一行就是 `### 准备原料`，整段做法当场丢掉）。按行扫的写法把「二级标题才算边界、
 * 三级标题属于正文」这条语义写死，不再依赖正则的边界细节。
 */
function sectionOf(text: string, heading: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** 做法步骤里那些「准备/工具」段落不进步骤（steps 是给掌勺者看的做法） */
function tidySteps(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, 2000);
}

// ---------------------------------------------------------------- HowToCook

/**
 * 筛选口径（§2.8、ADR-0006）：「家常热度 + 忌口排除」，**不按菜系**。
 *
 * 落到代码上是三条可判定的规则：
 *   ① 来源必须是我们认可的家常菜目录（HowToCook 的 `meat_dish` / `vegetable_dish` /
 *      `soup` / `staple` / `aquatic` 五个目录就是它的家常档——鱼虾家常菜当然算家常；
 *      `breakfast` / `drink` / `dessert` / `condiment` / `semi-finished` 不进主食推荐池）；
 *   ② 耗时要家常（原文有「预估烹饪难度：★」这档，★★★ 以上的费事菜不进冷启动——
 *      家里不会为了冷启动去做 3 小时的菜）；
 *   ③ **忌口排除在导入期就做一道粗筛**：菜名或主料里出现家人忌口的常见品种
 *      （动物内脏、贝类、小龙虾、血制品、苦瓜、肥肠…）就跳。这不是替代推荐期的
 *      硬过滤（那个由食材字典推导，永远生效），而是让外部池的**素材**先干净一层——
 *      省得导 300 道菜一半是不能上桌的。
 */
const HOME_DIRS = new Set(['meat_dish', 'vegetable_dish', 'soup', 'staple', 'aquatic']);

const HARD_EXCLUDE_WORDS = [
  '内脏', '猪肝', '鸡胗', '鸭胗', '猪腰', '猪肚', '肥肠', '大肠', '牛肚', '牛舌', '毛肚', '脑花',
  '血', '毛血旺', '鸭血', '猪血', '鱼腥草', '折耳根', '苦瓜', '螺蛳粉', '臭豆腐', '榴莲', '小龙虾',
  '生蚝', '生吃', '刺身', '醉虾', '醉蟹', '皮蛋',
];

/** 明确「费事」的口径：原文难度星级 ≥ ★★★ 且菜名里没有快手/懒人/简单这类字眼 */
function effortFrom(text: string, name: string): 'quick' | 'medium' | 'heavy' {
  const stars = /预估烹饪难度：\s*(★+)/.exec(text);
  const count = stars ? stars[1]!.length : 0;
  const quickHint = /快手|懒人|简单|简易|十分钟|五分钟|一人食/.test(name);
  if (quickHint) return 'quick';
  if (count >= 3) return 'heavy';
  if (count === 1) return 'quick';
  return 'medium';
}

/** 荤素类型：目录 + 菜名里的荤素字眼 */
export function kindFrom(dir: string, name: string, ingredients: string[]): RecipeKind {
  const isSoup = dir === 'soup' || /汤|羹|粥/.test(name);
  // 荤的判据是「有没有动物性主料」。**蛋不算荤**：这是本库既有的口径
  // （002 的番茄炒蛋、004 的紫菜蛋花汤都是 `veg` / `soup_veg`），导入的菜必须跟它一致，
  // 否则同一道「紫菜蛋花汤」在家里那一半是素汤、在外部池那一半是荤汤，结构配位会打架。
  const meatWords = /肉|鸡|鸭|牛|羊|猪|鱼|虾|蟹|排骨|培根|火腿|腊肠|丸|蛤|贝|鱿|鳝|蛙/;
  // 「鸡蛋」里含「鸡」、「鱼香」里含「鱼」——先把这类**词素陷阱**换成占位再判，
  // 否则蛋类菜会被判成荤菜（与 002/004 的既有口径打架）。
  const denoised = [name, ...ingredients].map((text) =>
    text.replace(/鸡蛋|鸭蛋|鹌鹑蛋|蛋花|蛋羹|蛋白|蛋黄|鱼香|鱼丸|虾皮|虾米/g, '○'),
  );
  const hasMeat = denoised.some((text) => meatWords.test(text));
  if (isSoup) return hasMeat ? 'soup_meat' : 'soup_veg';
  if (dir === 'vegetable_dish') return 'veg';
  return hasMeat ? 'meat' : 'veg';
}

/**
 * 解析一篇 HowToCook 的 markdown。**纯函数**：输入文本，输出 `DraftRecipe | undefined`。
 *
 * 返回 undefined 的三种情况（都进报告的「跳过」说明）：
 *   * 不是家常目录（饮品 / 甜点 / 早餐 / 调料 / 半成品）；
 *   * 命中忌口粗筛；
 *   * 没有「## 计算」段落——那是它给出份量的地方，缺了就没有可重标的项。
 */
export function parseHowToCook(relativePath: string, text: string): DraftRecipe | undefined {
  const path = relativePath.replace(/\\/g, '/');
  const parts = path.split('/');
  // 目录就是筛选口径的第一条：只有四个家常目录进导入（其余是饮品/甜点/早餐/调料/半成品）
  if (parts[0] !== 'dishes' || !HOME_DIRS.has(parts[1] ?? '')) return undefined;

  const fileStem = (parts[parts.length - 1] ?? '').replace(/\.md$/, '');
  // HowToCook 的菜名来自 H1（`# 简易红烧肉的做法`）；没有 H1 就回落文件名
  const titleMatch = /^#\s*(.+?)的做法\s*$/m.exec(text);
  const name = (titleMatch ? titleMatch[1]! : fileStem).trim();
  if (name === '') return undefined;

  if (HARD_EXCLUDE_WORDS.some((word) => name.includes(word))) return undefined;

  const calc = sectionOf(text, '计算');
  if (calc === undefined) return undefined;
  const ingredients = parseHowToCookIngredients(calc);
  if (ingredients.length === 0) return undefined;

  const stepsSection = sectionOf(text, '操作');
  const ingredientNames = ingredients.map((item) => item.name);

  return {
    // id 取「来源 + 菜名」的稳定散列：同一篇菜反复导入得到同一个 id（重跑幂等），
    // 且全是 ASCII（报告与 URL 里都能直接读）。散列而不是下标：HowToCook 的目录顺序会变。
    id: draftId('htc', name),
    name,
    aliases: [],
    kind: kindFrom(parts[1]!, name, ingredientNames),
    effort: effortFrom(text, name),
    source: 'howtocook',
    sourceRef: path,
    tastes: tastesFrom(name, ingredientNames),
    seasonMonths: seasonFrom(ingredientNames),
    cuisine: cuisineHintFrom(name),
    steps: tidySteps(stepsSection ? stripMarkdown(stepsSection) : ''),
    ingredients,
  };
}


/**
 * 「食材名 + 份量」的切分。切点选**第一个能确定的份量起点**：
 *   ① 阿拉伯/全角数字（`虾 250g`、`土豆 150g`）；
 *   ② 中文数字 + 单位词（`姜 一块`、`蒜 5-8 瓣` 里的「5」走①；`葱 一根` 走这里）；
 *   ③ 冒号（`主料：五花肉 300g` —— 冒号在名字一侧时切在冒号后）。
 *
 * 单位词是**封闭小集合**（家常菜谱的份量单位就这些）：不加这一条，`姜 一块` 会被整串当成食材名，
 * 于是「姜」这条项在归一阶段直接消失（真实数据跑出来的第一批失败清单里就有它）。
 */
const QUANTITY_UNITS = '克gG斤两mlML升个根片瓣块勺把段张杯份头颗只条朵粒撮碗盒袋瓶罐支枚半';

function splitNameQuantity(body: string): { name: string; quantity: string } | undefined {
  const marker = new RegExp(`[：:]|[\\d０-９]|[一二两三四五六七八九十半]\\s*[${QUANTITY_UNITS}]`);
  const hit = marker.exec(body);
  if (!hit) return undefined;
  const cut = hit.index;
  let name = body.slice(0, cut).trim();
  let rest = body.slice(cut).trim();
  // 冒号切点：冒号本身不属于名字，也不属于份量
  if (name.endsWith('：') || name.endsWith(':')) name = name.slice(0, -1).trim();
  if (rest.startsWith('：') || rest.startsWith(':')) rest = rest.slice(1).trim();
  return { name, quantity: rest };
}

/**
 * 「## 计算」段落的逐行解析。HowToCook 的实际形状（已核实 372 篇）：
 * 一条一行、`- 食材名 200g` 或 `- 食材名：约 3~4 斤`，也有嵌套子列表（`  - 生抽 10ml`）。
 * 名字可能是 `\`大肉\``（反引号包裹）。
 */
function parseHowToCookIngredients(section: string): RawIngredient[] {
  const items: RawIngredient[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-') && !line.startsWith('*')) continue;
    const body = line.replace(/^[-*]\s*/, '').trim();
    if (body === '' || body.startsWith('注') || body.startsWith('如果') || body.startsWith('使用上述')) continue;
    // 名字与份量切开（见 `splitNameQuantity`：中文数字 + 单位词也算份量的起点）
    const split = splitNameQuantity(body);
    if (!split) continue;
    let name = split.name;
    const quantity = split.quantity;
    if (name === '' || quantity === '') continue;
    // 去掉数量词尾巴（「盐量 = 份数」这类）与星号
    name = name.replace(/[*`]/g, '').replace(/量(=|＝).*$/, '').trim();
    if (name.length > 12 || /^\d/.test(name)) continue;
    if (/^[（(]|可选|注意/.test(name)) continue;

    items.push({
      name,
      adultGrams: parseGrams(quantity) ?? null,
      quantity,
      scaling: isSeasoning(name) ? 'fixed' : 'linear',
    });
  }
  return items;
}

// ---------------------------------------------------------------- 下厨房

/**
 * 轻量热榜解析（spec §2.8：「只轻量抓家常热榜或用现成小数据集，不搞全站爬」）。
 *
 * 解析的是**热榜页面**（`/explore/`）里那 20–50 张卡片：菜名 + 详情页 URL。
 * 详情页的原料表在 `parseXiachufangDetail`——两个函数分开，是因为热榜页本身
 * 只有菜名（原料表要再抓一次详情页）。这样「抓热榜」与「抓原料表」的失败可以分开降级：
 * 热榜抓到了、详情页没抓到 → 这些菜进报告的「跳过」，不会让整批导入失败。
 *
 * ⚠️ 本函数吃到的是**已经取回来的 HTML**（网络在 `scripts/import-library.ts` 里有界地做），
 * 这样测试不需要网络与 fixture 之外的任何东西。
 */
export function parseXiachufangHtml(html: string): { name: string; url: string }[] {
  const found: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  const pattern = /href="(\/recipe\/(\d+)\/)[^"]*"[^>]*>\s*([^<]{1,60}?)\s*<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const url = `https://www.xiachufang.com${match[1]!}`;
    const name = cleanXiachufangName(match[3]!);
    if (name === '' || seen.has(url)) continue;
    seen.add(url);
    found.push({ name, url });
  }
  return found;
}

/** 热榜卡片的名字里带 emoji / 感叹号 / 换行（实测），清成能用的菜名 */
function cleanXiachufangName(raw: string): string {
  return raw
    // 表情与装饰符号：用 Unicode 属性写，而不是把变体选择符塞进字符类
    // （`[❗️]` 这种「基字符 + 选择符」的字符类正是 ESLint 的 no-misleading-character-class 拦的写法，
    //   它在正则里的行为与肉眼所见不同）
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\uFE0F/gu, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[❗|·、,，]+/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .trim();
}

/**
 * 下厨房详情页的原料表（`<div class="ings"><table>` 里 名称 + 份量 两列，实测形状）。
 * 份量列写「适量」「两勺」「一个」这类模糊量 —— 正是本票 LLM 重标要处理的那一批。
 */
export function parseXiachufangDetail(html: string): RawIngredient[] {
  const block = /<div class="ings">([\s\S]*?)<\/table>/.exec(html);
  if (!block) return [];
  const items: RawIngredient[] = [];
  const rowPattern = /<td class="name">([\s\S]*?)<\/td>\s*<td class="unit">([\s\S]*?)<\/td>/g;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(block[1]!)) !== null) {
    const name = match[1]!
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '')
      .trim();
    const quantity = match[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (name === '') continue;
    items.push({
      name,
      adultGrams: parseGrams(quantity) ?? null,
      quantity: quantity === '' ? '适量' : quantity,
      scaling: isSeasoning(name) ? 'fixed' : 'linear',
    });
  }
  return items;
}

/** 把热榜条目 + 详情页原料表组装成一道草稿菜（详情页没原料表就返回 undefined，进「跳过」） */
export function xiachufangDraft(entry: { name: string; url: string }, html: string): DraftRecipe | undefined {
  const ingredients = parseXiachufangDetail(html);
  if (ingredients.length === 0) return undefined;
  const stepsMatch = /<div class="steps">([\s\S]*?)<\/div>/.exec(html);
  const steps = stepsMatch
    ? tidySteps(
        [...stepsMatch[1]!.matchAll(/<p class="text"[^>]*>([\s\S]*?)<\/p>/g)]
          .map((match, index) => `${index + 1}. ${stripHtml(match[1]!)}`)
          .join('\n'),
      )
    : '';

  return {
    id: draftId('xcf', entry.url),
    name: entry.name,
    aliases: [],
    kind: kindFrom('', entry.name, ingredients.map((item) => item.name)),
    effort: 'medium',
    // 来源如实标「爬取」（spec §2.8 明文：无开放许可，自家私用、风险自知接受）
    source: 'scraped',
    sourceRef: entry.url,
    tastes: tastesFrom(entry.name, ingredients.map((item) => item.name)),
    seasonMonths: seasonFrom(ingredients.map((item) => item.name)),
    cuisine: cuisineHintFrom(entry.name),
    steps,
    ingredients,
  };
}

// ---------------------------------------------------------------- LLM 生成的草稿

export interface LlmDraftInput {
  name: string;
  kind?: RecipeKind;
  effort?: 'quick' | 'medium' | 'heavy';
  tastes?: TasteTag[];
  cuisine?: RecipeCuisine | null;
  steps?: string;
  ingredients: { name: string; adultGrams?: number | null; quantity?: string; scaling?: 'linear' | 'fixed' }[];
}

/**
 * LLM 生成的菜**与另两个来源走同一条落库管线**（spec §2.8 的明文要求）。
 * 这个函数只负责把 LLM 的出参包装成 `DraftRecipe`——**它不生成、不调用 LLM、不联网**：
 * 生成由调用方（`scripts/import-library.ts` 或 #21 的转正路）做完，形状在这里收口。
 * 于是「LLM 生成的菜也是草稿、也有来源字段、也要归一与重标」这条纪律落在类型上，
 * 而不是靠调用方记得。
 */
export function llmGeneratedDraft(input: LlmDraftInput, generatedAt: string): DraftRecipe {
  const ingredients: RawIngredient[] = input.ingredients.map((item) => ({
    name: item.name,
    // LLM 没给克数就照模糊份量处理（`null` → 进重标队列），不塞一个编出来的默认值
    adultGrams: typeof item.adultGrams === 'number' && item.adultGrams > 0 ? item.adultGrams : null,
    quantity: item.quantity ?? (item.adultGrams ? `${item.adultGrams}g` : '适量'),
    scaling: item.scaling ?? (isSeasoning(item.name) ? 'fixed' : 'linear'),
  }));
  return {
    id: draftId('llm', input.name),
    name: input.name,
    aliases: [],
    kind: input.kind ?? kindFrom('', input.name, ingredients.map((item) => item.name)),
    effort: input.effort ?? 'medium',
    source: 'llm',
    sourceRef: generatedAt,
    tastes: input.tastes ?? tastesFrom(input.name, ingredients.map((item) => item.name)),
    seasonMonths: seasonFrom(ingredients.map((item) => item.name)),
    cuisine: input.cuisine ?? cuisineHintFrom(input.name),
    steps: tidySteps(input.steps ?? ''),
    ingredients,
  };
}

// ---------------------------------------------------------------- 标签初值（LLM 之外的确定性来源）

/**
 * 口味五标签的初值：按菜名与食材名里的字眼给。**这是导入时的初值，不是判定**——
 * LLM 初打（`llm/import-schema.ts`）拿到它的输出后可以改；转正时（#21）掌勺者再校对。
 * 给初值的理由：LLM 不可用时（离线、端点挂了）导入照样要能落库，标签不能是空。
 */
export function tastesFrom(name: string, ingredients: string[]): TasteTag[] {
  const corpus = [name, ...ingredients].join(' ');
  const tastes: TasteTag[] = [];
  if (/糖|甜|可乐|蜜|拔丝|冰糖/.test(corpus)) tastes.push('甜');
  if (/辣|椒|豆瓣|麻辣|花椒|小米辣|剁椒|泡椒/.test(corpus)) tastes.push('辣');
  if (/醋|酸|番茄|柠檬|酸菜|泡菜/.test(corpus)) tastes.push('酸');
  if (/笋|鲜|蚝油|生抽|蒸|菌|菇|鸡精/.test(corpus)) tastes.push('咸鲜');
  if (/清|白灼|蒸|拌|汆|煲|淡/.test(corpus)) tastes.push('清淡');
  return tastes.length > 0 ? [...new Set(tastes)].slice(0, 3) : ['咸鲜'];
}

/** 时令月份的初值：从食材名里认出那些「只有一季」的菜（按自家菜场口径，与迁移里的表同一口径） */
const SEASON_WORDS: Record<string, number[]> = {
  白菜: [11, 12, 1, 2],
  娃娃菜: [11, 12, 1, 2],
  菠菜: [11, 12, 1, 2, 3],
  萝卜: [10, 11, 12, 1, 2],
  冬瓜: [6, 7, 8, 9],
  丝瓜: [6, 7, 8, 9],
  苦瓜: [6, 7, 8, 9],
  黄瓜: [6, 7, 8],
  茄子: [6, 7, 8, 9],
  番茄: [6, 7, 8, 9],
  西红柿: [6, 7, 8, 9],
  玉米: [6, 7, 8, 9],
  豆角: [6, 7, 8, 9],
  豇豆: [6, 7, 8, 9],
  韭菜: [3, 4, 5, 6],
  茼蒿: [11, 12, 1, 2, 3],
  空心菜: [5, 6, 7, 8, 9],
  秋葵: [6, 7, 8, 9],
  竹笋: [3, 4, 5],
  春笋: [3, 4, 5],
  藕: [9, 10, 11, 12, 1],
  莲藕: [9, 10, 11, 12, 1],
  南瓜: [8, 9, 10],
  胡萝卜: [10, 11, 12, 1],
  芹菜: [11, 12, 1, 2, 3],
  香菇: [11, 12, 1, 2],
  红薯: [9, 10, 11, 12],
  土豆: [10, 11, 12, 1],
  毛豆: [6, 7, 8, 9],
};

function seasonFrom(ingredientNames: string[]): number[] {
  const months = new Set<number>();
  for (const name of ingredientNames) {
    for (const [word, list] of Object.entries(SEASON_WORDS)) {
      if (name.includes(word)) list.forEach((month) => months.add(month));
    }
  }
  return [...months].sort((a, b) => a - b);
}

/**
 * 菜系参考 tag 的初值：菜名里的地名/流派字眼给一个高置信度的判断，
 * 判断不了就留 `null`（LLM 初打或转正时校对再补）。**不做过滤**——
 * 菜系在这个产品里从不参与筛选（§2.8、ADR-0006），它只是给家人看的一句参考。
 */
export function cuisineHintFrom(name: string): RecipeCuisine | null {
  const table: [RegExp, RecipeCuisine][] = [
    [/川|麻婆|回锅|宫保|水煮|夫妻肺片|担担|鱼香|辣子|毛血旺|口水/, '川'],
    [/粤|白灼|清蒸|煲仔|豉汁|菠萝咕|蚝油生菜/, '粤'],
    [/鲁|糖醋鲤|九转|葱烧|爆炒腰花|把子肉/, '鲁'],
    [/苏|浙|东坡|西湖|腌笃鲜|松鼠桂|龙井|叫花/, '苏浙'],
    [/湘|剁椒|腊味|小炒肉|口味虾/, '湘'],
    [/东北|地三鲜|锅包|酸菜白肉|乱炖|大拉皮/, '东北'],
    [/闽|佛跳墙|荔枝肉|沙茶/, '闽'],
    [/徽|臭鳜鱼|毛豆腐/, '徽'],
    [/西北|新疆|兰州|陕西|羊肉泡|大盘鸡|biang/, '西北'],
    [/京|老北京|炸酱面|京酱|卤煮|爆肚/, '京'],
    [/家常|妈妈|小时候|自家|农家/, '家常'],
  ];
  for (const [pattern, cuisine] of table) {
    if (pattern.test(name)) return cuisine;
  }
  return null;
}

// ---------------------------------------------------------------- 杂项

/** 步骤里的 markdown 修饰（`**`、图片、链接）清掉——steps 是给掌勺者读的纯文本 */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`>#]/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * 菜名 → id。**稳定散列**：同一道菜反复导入得到同一个 id（重跑幂等，不会越导越多），
 * 且全是 ASCII（报告与 URL 里都能直接读）；菜名本身进 `name` 列，不靠 id 传达。
 * 前缀 `htc_` / `xcf_` / `llm_` 是来源，与 `recipes.source` 同口径。
 */
export function draftId(prefix: 'htc' | 'xcf' | 'llm', key: string): string {
  const digest = createHash('sha1').update(`${prefix}:${key}`).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

/**
 * 菜名 → 文件名段（只用于**下厨房详情页**的临时落盘名，不参与 id）。
 * 保留汉字（可读、可检索），只把会惹麻烦的字符换掉。
 */
export function slugOf(name: string): string {
  const cleaned = name
    .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'dish' : cleaned;
}
