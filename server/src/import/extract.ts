/**
 * 来源素材的**取正文层**（issue #32）：把「一个链接」或「一段文字」读成**一段可结构化的素材**。
 *
 * 这层只管一件事：**拿到尽可能完整的文字素材**，不碰 LLM、不碰数据库、不猜克数。
 *
 * ## 站点无关的阶梯（这是本模块的核心结构）
 *
 * 链接来自哪里**不可预知**（小红书、下厨房、知乎、搜狐号、博主自建站…），所以这里**不认平台**，
 * 只按「页面上有什么」逐档下沉。每一档都实现在一个纯函数里、都能离线测：
 *
 *   ① **JSON-LD `Recipe`**（`parseJsonLdRecipe`）——**最通用的一档**，schema.org 的菜谱标准结构，
 *      菜谱站与很多 SEO 好的媒体都嵌（Google 菜谱搜索吃的就是它）。有它就用它，**一跳到位**：
 *      食材与步骤都是结构化字段，比从正文里猜准得多，也不需要任何站点适配。
 *   ② **站点适配器**（`ADAPTERS`）——对「①取不到、但结构特殊」的站点各写一个。目前只有小红书
 *      （笔记正文 + **视频字幕**：视频类内容的做法主要在字幕里，页面 DOM 里没有）。
 *   ③ **通用正文**——① ② 都没有时的兜底。
 *
 * ## 三条硬纪律（都是实测换来的）
 *
 *   * **抓不到就诚实报错**。很多站点直接抓不到（实测：下厨房菜谱详情页要人机验证、知乎 403、
 *     美食中国 403、要登录的页面），**这不是缺陷而是现实**——用户手里有那段文字，
 *     让他贴进来是成本最低的路。假装「支持任意链接」比老实说「这个抓不到」更坏。
 *   * **绝不静默替换内容**。通用兜底从**整页**抽文字，而页面里含推荐流/侧边栏**其他菜谱**，
 *     也可能抽到导航与页脚。所以兜底有明确的证据要求（`looksLikeRecipeContent`，见 `extractFromUrl`），
 *     证据不够就**报错**，宁可让用户贴文字，也不把一道别的菜送进家庭菜谱库。
 *   * **不猜 URL、不用平台私有 API**：只有公开页面 + 页面里公开内嵌的数据。适配器失效时报错就行。
 *
 * ## 解析与网络的边界
 *
 * 所有 `parse*` 都是**纯函数**（吃字符串、吐结构化数据），测试跑在仓库内的 fixture 上、
 * **不需要网络**。网络只出现在 `extractFromUrl` 这一个编排函数里。
 */

/** 素材长度上限（字符）：够长的视频字幕 + 正文，但挡得住把整本书贴进来 */
export const MAX_SOURCE_TEXT_LENGTH = 20_000;

/**
 * 通用兜底的最小正文长度：比 `MIN_SOURCE_TEXT_LENGTH` 高得多。
 *
 * 为什么两个门不合并：`MIN_SOURCE_TEXT_LENGTH` 是「**用户贴进来的文字**太短就诚恳说太短」；
 * 这个是「**从网页里抽出来**的文字太少，多半是壳页/视频页」——后者要严得多，
 * 因为从网页抽的正文里本来就夹着导航与杂项，20 字能过但基本没信息。
 */
export const MIN_GENERIC_TEXT_LENGTH = 80;

/** 单个素材最多取几条字幕文件（多语言重复时只取前几条，挡无界循环） */
const MAX_SUBTITLE_FILES = 3;

/** 图片来源的取正文超时（毫秒）。**必须有界**：外站卡住不能拖死这次导入 */
export const FETCH_TIMEOUT_MS = 12_000;

export interface ExtractedSource {
  /** 这条素材该记进 `recipes.source_ref` 的值（链接本身，或「粘贴的文字」） */
  sourceRef: string;
  /** 素材标题（有就用；没有就空串——菜名由 LLM 从正文里判） */
  title: string;
  /** 正文素材（字幕已拼入）。**交给 LLM 的就是它** */
  text: string;
  /** 这一路怎么走过来的（降级、截断、字幕取到几条）——进响应的 notes，不静默 */
  notes: string[];
}

/**
 * 浏览器样式的 UA。
 *
 * **为什么不诚实地报「DinnerOrder/0.1」**（那是本来的写法，实测撞墙）：不少站点对非浏览器 UA
 * 直接给登录页/验证页（小红书 302 `/login` 且**返回 200**），于是我们拿到的是登录页而不是内容。
 * 仓库已有的下厨房爬取器（`scripts/fetch-xiachufang.ts`）出于同一原因用浏览器 UA，
 * ADR-0006 已接受这类「自家私用爬取」的风险。
 *
 * **移动端优先**：实测同一链接，桌面 Chrome UA 可能被 302 到 `/login`，而移动 UA 拿到完整内容
 * （小红书分享链就是移动端 H5）。先试移动 UA，被抓到登录页/验证页再用桌面 UA 重试一次
 * （两边都有真实站点偏好，不假定哪个一定好）。
 *
 * 这条只用于**用户自己贴进来的公开链接**：不登入、不带 cookie、不绕任何付费或权限，
 * 拿的就是他本来在浏览器里能看到的那个页面。真需要登录时报「要登录」让他贴文字。
 *
 * **必须纯 ASCII**：HTTP 头是 ByteString，带中文会直接抛（实测：“Cannot convert argument
 * to a ByteString”）——中文说明只能写在这里，不能写进头部。
 */
const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** 被抓到这些路径上 = 没拿到内容（要登录/要过人机验证），报错而不是把那个页面当素材 */
const GATEKEEPER_PATH = /\/(login|signin|auth|passport|verify|captcha|humancheck|challenge)/i;

/** 取正文失败（网络、状态码、页面根本不是笔记）：**报出来**，让界面提示改用贴文字 */
export class SourceFetchError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`取不到这个链接的内容（${reason}）：${url}`);
    this.name = 'SourceFetchError';
  }
}

/** 素材为空/太短：没什么可结构化的（**不改用**：这种情况报错比让模型硬编一道菜好） */
export class SourceTooShortError extends Error {
  constructor(readonly length: number) {
    super(`素材太短（${length} 字），看不出是一道菜的做法。请贴完整的做法文字。`);
    this.name = 'SourceTooShortError';
  }
}

/** 素材短于这个长度就没法判「这是什么菜」——与其让模型编，不如让掌勺者把文字贴全 */
export const MIN_SOURCE_TEXT_LENGTH = 20;

// ---------------------------------------------------------------- 纯解析（可离线测试）

/**
 * 从 HTML 里读 `<title>` 与 meta description，并把可见文字抽出来。
 *
 * 不引 HTML 解析库（本票明确不为此加运行时依赖）：只做三件确定的事——去 `script`/`style`
 * 整块、去标签、解实体。抽出来的文字不求排版正确，只求**给模型足够的文字**。
 */
export function parseHtmlDocument(html: string): { title: string; description: string; bodyText: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const description =
    decodeEntities(metaContent(html, 'og:description') || metaContent(html, 'description')).trim();
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const bodyText = collapseWhitespace(
    decodeEntities(withoutBlocks.replace(/<[^>]+>/g, ' ')),
  ).trim();
  return { title, description, bodyText };
}

/**
 * 小红书笔记页的内嵌数据（`window.__INITIAL_STATE__`）。
 *
 * 返回 `undefined` = 这不是小红书笔记页（或改版后字段搬了家）——调用方据此回落到通用 HTML，
 * **不抛错**：回落是设计内的第二档，不是失败。
 *
 * 提取三样：
 *   * `title` —— 笔记标题（`noteData.title`），菜名最好的来源；
 *   * `desc` —— 笔记正文（`noteData.desc`），含话题标签；
 *   * `subtitleUrls` —— **视频字幕地址**（`video.mediaV2` 里 `subtitles` 的 `zh-CN`/`source` 档）。
 *     `mediaV2` 是一层**字符串化的 JSON**（平台就这么存的），要再 `JSON.parse` 一次。
 */
export function xiaohongshuNote(html: string): { title: string; desc: string; subtitleUrls: string[] } | undefined {
  const state = readInitialState(html);
  if (!state) return undefined;
  const note = pickNoteData(state.noteData);
  if (!note) return undefined;
  const video = (note.video ?? {}) as { mediaV2?: unknown };
  const urls: string[] = [];
  if (typeof video.mediaV2 === 'string') {
    try {
      const media = JSON.parse(video.mediaV2) as {
        video?: { subtitles?: Record<string, { url?: unknown }[]> };
      };
      const subtitles = media.video?.subtitles ?? {};
      // 优先中文档，其次 `source`（原文字幕），英文档只在都没有时才用
      for (const language of ['zh-CN', 'source', 'en-US']) {
        for (const entry of subtitles[language] ?? []) {
          if (typeof entry?.url === 'string' && entry.url !== '' && !urls.includes(entry.url)) urls.push(entry.url);
          if (urls.length >= MAX_SUBTITLE_FILES) break;
        }
        if (urls.length >= MAX_SUBTITLE_FILES) break;
      }
    } catch {
      // mediaV2 不是合法 JSON：字幕这一档取不到，正文照用（不是失败）
    }
  }
  return {
    title: typeof note.title === 'string' ? note.title.trim() : '',
    desc: typeof note.desc === 'string' ? note.desc.trim() : '',
    subtitleUrls: urls,
  };
}

/**
 * 从 `__INITIAL_STATE__.noteData` 里找出**真正的笔记**。
 *
 * 页面有**两种层深**（本会话里先按浅层写完、真跑才发现，这是实测结论不是猜测）：
 *   * 笔记页（老的直出形状）：`noteData` 本身就是笔记（`title` / `desc` / `video`）；
 *   * 分享链接落地页（当前形状）：`noteData` 是**路由包装**，里面才是笔记：
 *     `noteData.data.noteData`。
 *
 * 只认一种的后果很重：认不出就当「不是笔记页」，而现在的行为是不回落到通用 HTML，
 * 直接报错——功能看似能用、实际全量失败。所以两种都认，且**以能否拿到 `desc`/`title` 为判据**
 * （不看 `type` 之类的其他字段：那些字段各版本名字不一）。
 */
function pickNoteData(raw: unknown): { title?: unknown; desc?: unknown; video?: unknown } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const outer = raw as { title?: unknown; desc?: unknown; video?: unknown; data?: unknown };
  if (isNoteShaped(outer)) return outer;
  const nested = (outer.data as { noteData?: unknown } | undefined)?.noteData;
  if (nested !== undefined && typeof nested === 'object' && nested !== null) {
    const inner = nested as { title?: unknown; desc?: unknown; video?: unknown };
    if (isNoteShaped(inner)) return inner;
  }
  return undefined;
}

/** 这个对象看起来是不是一道笔记（有标题或正文，或带 video） */
function isNoteShaped(candidate: { title?: unknown; desc?: unknown; video?: unknown }): boolean {
  return typeof candidate.title === 'string' || typeof candidate.desc === 'string' || candidate.video !== undefined;
}

/**
 * 把 srt 字幕读成纯文字。**去掉序号与时间轴**，只留台词（模型不需要时间信息）。
 *
 * 同一句重复出现时**保留**（视频里的重复是刻意的强调，不是脏数据）；顺手把 srt 的
 * `\N`/`\n` 行内换行并成一句。
 */
export function parseSrt(srt: string): string {
  const lines: string[] = [];
  for (const rawLine of srt.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 序号行（纯数字）与时间轴行（`00:00:01,000 --> 00:00:02,000`）都不是台词
    if (line === '' || /^\d+$/.test(line) || line.includes('-->')) continue;
    lines.push(line.replace(/\\N/gi, ' '));
  }
  return lines.join('\n');
}

/**
 * 把各档素材拼成交给模型的正文。**顺序即优先级**：标题 → 正文描述 → 字幕转录。
 * 空块不占位（不留空行，免得模型把空白当信息）。
 */
export function composeSourceText(parts: { title?: string; description?: string; body?: string; transcript?: string }): string {
  return [parts.title, parts.description, parts.body, parts.transcript]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join('\n');
}

/** 截断到上限并说清截了多少（返回的 note 为空串 = 没截） */
export function clampSourceText(text: string): { text: string; note: string } {
  if (text.length <= MAX_SOURCE_TEXT_LENGTH) return { text, note: '' };
  return {
    text: text.slice(0, MAX_SOURCE_TEXT_LENGTH),
    note: `素材过长，已截断到 ${MAX_SOURCE_TEXT_LENGTH} 字（原 ${text.length} 字）`,
  };
}

// ---------------------------------------------------------------- 编排（唯一有网络的地方）

export interface ExtractOptions {
  /** 注入 fetch（测试用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 把一段**粘贴的文字**读成素材。没有网络这一档——它是链接那条路失败时的兜底，
 * 也是最可控的一条输入（掌勺者自己决定给什么）。
 */
export function extractFromText(text: string): ExtractedSource {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SOURCE_TEXT_LENGTH) throw new SourceTooShortError(trimmed.length);
  const clamped = clampSourceText(trimmed);
  return {
    sourceRef: '粘贴的文字',
    title: '',
    text: clamped.text,
    notes: clamped.note === '' ? ['素材来自粘贴的文字'] : [`素材来自粘贴的文字`, clamped.note],
  };
}

/**
 * 取一个链接的正文——**站点无关的阶梯**（①②③ 见文件头）。
 *
 * 两处网络行为值得一提：
 *   * **UA 升降级**：先移动 UA，拿到登录/验证页再用桌面 UA 重试一次（两边都有真实站点偏好）。
 *   * **适配器可以再走一跳**（小红书的字幕文件）。适配器自己的附加跳失败**不整体失败**：
 *     页面拿到了只是素材少一点，而不是这次导入废了。
 *
 * 失败全部抛 `SourceFetchError`（带一句人能懂的原因），界面据此提示改用贴文字。
 */
export async function extractFromUrl(url: string, options: ExtractOptions = {}): Promise<ExtractedSource> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const notes: string[] = [];

  const fetched = await fetchPage(url, doFetch, timeoutMs);
  const html = fetched.html;
  const generic = parseHtmlDocument(html);

  // ① JSON-LD Recipe（最通用：不认站点，直接给结构化字段）
  const jsonLd = parseJsonLdRecipe(html);
  if (jsonLd) {
    notes.push(
      `按菜谱结构化数据读取（食材 ${jsonLd.ingredients.length} 项、步骤 ${jsonLd.steps.length} 步）`,
    );
    const composed = composeSourceText({
      title: jsonLd.name === '' ? generic.title : jsonLd.name,
      description: generic.description,
      body: jsonLd.ingredients.length > 0 ? `【食材】\n${jsonLd.ingredients.join('\n')}` : '',
      transcript: jsonLd.steps.length > 0 ? `【做法】\n${jsonLd.steps.join('\n')}` : '',
    });
    return finishSource(url, jsonLd.name === '' ? generic.title : jsonLd.name, composed, notes);
  }

  // ② 站点适配器（目前只有小红书：视频内容的做法在字幕里，DOM 里没有）
  for (const adapter of ADAPTERS) {
    if (!adapter.matches(url)) continue;
    const hit = adapter.parse(html);
    if (!hit) {
      // 认得出是这个站点、但读不出内容（改版/未登录）：**报错，不回落到通用抽取**。
      // 通用抽取在推荐流页面上会抽到**其他笔记/其他菜**（实测：想要「牛肉豆腐煲」得到「黄酒煮鸡」）。
      throw new SourceFetchError(url, `${adapter.label}页面的结构变了或需要登录，读不出内容`);
    }
    notes.push(`按${adapter.label}读取（正文 ${hit.desc.length} 字，字幕 ${hit.subtitleUrls.length} 条）`);
    const transcript = await fetchSubtitles(hit.subtitleUrls, doFetch, timeoutMs, notes);
    if (hit.subtitleUrls.length > 0 && transcript === '') {
      notes.push('没取到字幕——做法里的手法可能不全，请照视频补一下');
    }
    const composed = composeSourceText({
      title: hit.title === '' ? generic.title : hit.title,
      description: hit.desc,
      transcript,
    });
    return finishSource(url, hit.title === '' ? generic.title : hit.title, composed, notes);
  }

  // ③ 通用正文（最后一档）：只收「有结构证据的正文」，且**证据不够就报错**
  const structured = extractStructuredText(html);
  const evidence = looksLikeRecipeContent(structured.text);
  if (!evidence.ok) {
    throw new SourceFetchError(
      url,
      `这个页面看不出是菜谱（${evidence.reason}）`,
    );
  }
  notes.push(`按网页正文读取（${evidence.reason}）`);
  const composed = composeSourceText({
    title: generic.title,
    description: generic.description,
    body: structured.text,
  });
  return finishSource(url, generic.title, composed, notes);
}

/** 一次有界 GET，带 UA 升降级与登录/验证页判定 */
async function fetchPage(
  url: string,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ html: string; finalUrl: string }> {
  let lastReason = '';
  for (const userAgent of [MOBILE_USER_AGENT, DESKTOP_USER_AGENT]) {
    let response: Response;
    try {
      response = await doFetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      lastReason = cause instanceof Error ? cause.message : String(cause);
      continue;
    }
    if (!response.ok) {
      // 429 = 「慢一点」：**不换 UA 重试**（那正是加剧限流、也显得在滥用），直接如实报。
      if (response.status === 429) {
        throw new SourceFetchError(url, '这个站点在限流（HTTP 429）——过一会儿再试，或直接贴文字');
      }
      lastReason = `HTTP ${response.status}`;
      // 4xx 换 UA 也没用（403 除外：有些站按 UA 拒），5xx 值得重试一下
      if (response.status < 500 && response.status !== 403) break;
      continue;
    }
    const finalUrl = response.url === '' ? url : response.url;
    if (GATEKEEPER_PATH.test(finalUrl)) {
      // 被重定向到登录/验证页：站点对「看起来不像人」的请求就是这么处理的。
      // 不报清楚的话，拿到的是那个页面，模型要么编一道菜、要么报个莫名其妙的形状错误（实测）。
      lastReason = '这个链接要登录或过人机验证才能看';
      continue;
    }
    return { html: await response.text(), finalUrl };
  }
  throw new SourceFetchError(url, lastReason === '' ? '取不到内容' : lastReason);
}

/** 逐条取字幕（适配器的附加跳）；全部失败也不报错，只是素材少一点 */
async function fetchSubtitles(
  urls: string[],
  doFetch: typeof fetch,
  timeoutMs: number,
  notes: string[],
): Promise<string> {
  let transcript = '';
  for (const subtitleUrl of urls) {
    try {
      const response = await doFetch(subtitleUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        notes.push(`一条字幕没取到（HTTP ${response.status}）`);
        continue;
      }
      const text = parseSrt(await response.text());
      if (text !== '') transcript = transcript === '' ? text : `${transcript}\n${text}`;
    } catch (cause) {
      notes.push(`一条字幕没取到（${cause instanceof Error ? cause.message : String(cause)}）`);
    }
  }
  return transcript;
}

/** 收尾三件套：截断、太短就报错、拼出结果 */
function finishSource(url: string, title: string, composed: string, notes: string[]): ExtractedSource {
  const clamped = clampSourceText(composed);
  if (clamped.note !== '') notes.push(clamped.note);
  if (clamped.text.length < MIN_SOURCE_TEXT_LENGTH) throw new SourceTooShortError(clamped.text.length);
  return { sourceRef: url, title, text: clamped.text, notes };
}

/**
 * 通用兜底的**证据闸门**（决定「这页看着像不像一道菜的做法」）：
 *
 *   * 文字太薄 → 拒（大概率是个壳页 / 视频页 / 图片墙，做法不在 DOM 里）；
 *   * 一条**做法信号**都没有 → 拒。信号只看两个：**编号步骤**（`1.` / `第一步` / `Step 1`）
 *     与**份量量词**（`克`/`g`/`毫升`/`ml`/`勺`/`适量`/`少许`）。
 *     同一网页里这两个都能撞上是常事，**两个都撞不上**就基本不是菜谱页
 *     （实测：B 站视频页只有标题与评论，知乎/下厨房被挡在 403/验证页）；
 *   * 过了两道闸门就放行，理由（多少字、命中什么）写进 notes——**不静默放行**。
 */
function looksLikeRecipeContent(text: string): { ok: true; reason: string } | { ok: false; reason: string } {
  const length = text.length;
  if (length < MIN_GENERIC_TEXT_LENGTH) {
    return { ok: false, reason: `正文只有 ${length} 字，做法多半不在网页里（视频/图片内容要粘贴文字）` };
  }
  const signals: string[] = [];
  const stepCount = (text.match(/(^|\n)\s*(\d+[.、)）]|第[一二三四五六七八九十]+步|Step\s*\d)/gi) ?? []).length;
  if (stepCount >= 2) signals.push(`${stepCount} 处编号步骤`);
  const unitCount = (text.match(/\d+\s*(克|g|G|千克|公斤|kg|毫升|ml|ML|勺|碗|瓣|片|个)/g) ?? []).length;
  if (unitCount >= 2) signals.push(`${unitCount} 处份量`);
  if (signals.length === 0) {
    return { ok: false, reason: '正文里找不到步骤或份量，看不出是菜谱（改用贴文字更稳）' };
  }
  return { ok: true, reason: `正文 ${length} 字，含${signals.join('、')}` };
}

// ---------------------------------------------------------------- 站点适配器

/**
 * 一个站点适配器：`matches` 判「这是不是那个站点」，`parse` 从 HTML 里读出内容。
 *
 * **适配器刻意很少**：通用能力（JSON-LD 与结构化正文）不写在这里，它们对所有站点生效；
 * 只有「结构特殊到通用档读不出来」的站点才值得一个适配器。目前只有小红书一类：
 * 内容是**视频**，做法在**字幕**里，而 DOM 里根本没有字幕。
 */
interface SiteAdapter {
  /** 站点名（进 notes 与人话错误） */
  label: string;
  /** 判 URL 是不是这个站点（只看 host） */
  matches(url: string): boolean;
  /** 从 HTML 读内容；`undefined` = 是这个站点但读不出来（调用方报错，不回落） */
  parse(html: string): { title: string; desc: string; subtitleUrls: string[] } | undefined;
}

/**
 * 小红书（分享短链 `xhslink.cn` 与 `xiaohongshu.com`）。
 *
 * 分享链**必须用移动 UA**（实测：桌面 UA 被 302 到 `/login` 且返回 200，拿到登录页），
 * 而且必须带 `xsec_token`——不带 token 的裸笔记 URL 会跳 `/404`。
 * 这两条都是站点行为，不是我们的选择；失效时报错让用户贴文字。
 */
const xiaohongshuAdapter: SiteAdapter = {
  label: '小红书',
  matches(url) {
    return /(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.cn$/i.test(hostOf(url));
  },
  parse(html) {
    return xiaohongshuNote(html);
  },
};

const ADAPTERS: SiteAdapter[] = [xiaohongshuAdapter];

// ---------------------------------------------------------------- 小工具

/** 取一个 URL 的 host（解析失败就给空串：调用方只拿它做站点判定） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * JSON-LD 的 `Recipe`（schema.org）——**最通用的一档**，不认站点。
 *
 * 为什么它是首选：菜谱站与很多 SEO 认真的媒体都嵌它（Google 菜谱搜索就吃这个），
 * 而且它**直接给结构化字段**（`recipeIngredient` / `recipeInstructions`），
 * 比从整页文字里猜准得多——不需要任何站点适配，也不会把推荐流的别的菜抽进来。
 *
 * 认出多种合法写法（都是实测/规范里存在的）：
 *   * `@type` 为 `"Recipe"`，或在 `@graph` 数组里；页面可有多个 ld+json script；
 *   * `recipeInstructions` 可以是字符串、`HowToStep` 数组、`HowToSection` 嵌套项，或是上面几种的混合；
 *   * `recipeIngredient` 是字符串数组；
 *   * `recipeYield` / `totalTime` 之类的不取（家常菜谱不看这些）。
 *
 * 返回 `undefined` = 这页没嵌可用的 Recipe。**不报错**：没嵌 JSON-LD 是绝大多数情况，
 * 应该安静地下沉到下一档。
 */
export function parseJsonLdRecipe(html: string): ExtractedRecipe | undefined {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!.trim());
    } catch {
      continue;
    }
    for (const node of collectLdNodes(parsed)) {
      const recipe = asRecipeNode(node);
      if (recipe) return recipe;
    }
  }
  return undefined;
}

/** 把 ld+json 的顶层结构展平成候选节点（支持 `@graph`、顶层数组、以及 `mainEntity` 包装） */
function collectLdNodes(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed.flatMap((item) => collectLdNodes(item));
  if (typeof parsed !== 'object' || parsed === null) return [];
  const node = parsed as Record<string, unknown>;
  const nodes: unknown[] = [node];
  if (Array.isArray(node['@graph'])) nodes.push(...node['@graph'].flatMap((item: unknown) => collectLdNodes(item)));
  if (node.mainEntity) nodes.push(...collectLdNodes(node.mainEntity));
  return nodes;
}

/** 这个节点是不是一道菜谱；是就抽成 `ExtractedRecipe` */
function asRecipeNode(node: unknown): ExtractedRecipe | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']]).map((type) =>
    String(type ?? '').toLowerCase(),
  );
  if (!types.includes('recipe')) return undefined;

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const ingredients = toStringList(record.recipeIngredient);
  const steps = instructionsToSteps(record.recipeInstructions);
  // 两样都没有的「Recipe」节点是空的（有些站只有名字）——不如下沉到下一档
  if (ingredients.length === 0 && steps.length === 0) return undefined;
  return { name, ingredients, steps };
}

/** `recipeIngredient` 这类「字符串或字符串数组」字段归一成数组 */
function toStringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

/**
 * `recipeInstructions` 抽成步骤文本。四种写法都要认（规范允许它们自由组合）：
 * 字符串 / `HowToStep`（有 `text`）/ `HowToSection`（有 `itemListElement` 子步骤）/ 上面几种的数组。
 */
function instructionsToSteps(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    // 换行分隔的一整段
    const byLine = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (byLine.length > 1) return byLine;
    // 实测：许多站点把步骤塞在**一个字符串**里、用编号分隔（`0.xxx,1.xxx,2.xxx`）。
    // 不拆的话整道菜只剩「1 步」，那一步是一大块文字——很隐蔽的错（预览看着像有内容）。
    const byNumber = trimmed
      .split(/(?=\d{1,2}\s*[.、)）]\s*\S)/)
      // 拆点在编号前，所以逗号留在**上一步的末尾**（`0.甲,1.乙` → `0.甲,` + `1.乙`）——
      // 把尾部标点剥掉（半角/全角逗号、顿号、分号），免得步骤读起来像断了
      .map((step) => step.trim().replace(/[,，、;；]+$/, ''))
      .filter(Boolean);
    return byNumber.length > 1 ? byNumber : [trimmed];
  }
  if (Array.isArray(value)) return value.flatMap((item) => instructionsToSteps(item));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim() !== '') return [record.text.trim()];
  if (record.itemListElement) return instructionsToSteps(record.itemListElement);
  return [];
}

/**
 * 一档「站点结构抽取」的结果。比 `ExtractedSource` 窄：只描述**内容本身**，
 * 不含来源与 notes（那些由 `extractFromUrl` 在编排层拼上）。
 */
export interface ExtractedRecipe {
  /** 标题（可能为空串：正文里有足够信息就行） */
  name: string;
  /** 食材名（可能为空数组：这一档可能只给了步骤） */
  ingredients: string[];
  /** 步骤文本（可能为空数组） */
  steps: string[];
}

/** 一行标签：`<span class="x">用料</span><div class="y">…` */
interface LabelledBlock {
  label: string;
  text: string;
}

/**
 * **通用正文**（第三档）：从 HTML 里抽「像做法」的文字，**而不是整页文字**。
 *
 * 为什么不整页抽：页面里含导航、页脚、评论、以及**推荐流的其他菜谱**。
 * 全倒给模型轻则噪声干扰、重则让它写出**另一道菜**（本轮实测真实踩到过这件事）。
 * 所以这里只收「有结构证据的正文」：`<article>` / `<main>` 内部，或带 `recipe` / `content` /
 * `post` / `entry` 这类语义类名的容器（菜谱站的正文容器几乎必命中其一）。
 * 抽不到这类容器 + 正文太薄时就返回空，由调用方**报错**而不是硬喂。
 *
 * 另外把「标签 + 内容」的成对块（如「用料」/「做法」小标题下的清单与步骤）按原样保留
 * ——那恰好是模型分段读食材/步骤的线索。
 */
export function extractStructuredText(html: string): { blocks: LabelledBlock[]; text: string } {
  // 先把干扰块整块去掉（它们不是做法：评论/推荐/页脚/脚本/样式）
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const containerPattern = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const classPattern =
    /<(div|section|article|main)\b[^>]*class=["'][^"']*\b(recipe|content|post|entry|article|ingredients?|steps?|method|directions?)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;

  const blocks: LabelledBlock[] = [];
  for (const pattern of [containerPattern, classPattern]) {
    for (const match of cleaned.matchAll(pattern)) {
      const inner = match[2] ?? '';
      blocks.push(...toLabelledBlocks(inner));
    }
  }
  // 容器都抽不到时退回整页（但下游的 `looksLikeRecipeContent` 会卡证据）
  if (blocks.length === 0) blocks.push(...toLabelledBlocks(cleaned));

  const text = blocks
    .map((block) => (block.label === '' ? block.text : `【${block.label}】\n${block.text}`))
    .join('\n')
    .trim();
  return { blocks, text };
}

/** 把一块 HTML 切成「行」：每个块级元素/换行算一行，去标签后丢掉空行 */
function toLabelledBlocks(html: string): LabelledBlock[] {
  const result: LabelledBlock[] = [];
  const lines = html
    .replace(/<(br|p|div|li|tr|h[1-6]|section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n');
  for (const rawLine of lines) {
    const line = collapseWhitespace(decodeEntities(rawLine)).replace(/\n+/g, ' ').trim();
    if (line === '' || line.length > 400) continue;
    // 「用料」「做法」这类短标题单独成块（它是模型分段读的线索）
    if (/^(用料|食材|主料|辅料|调料|配料|做法|步骤|制作|方法|Ingredients?|Steps?|Directions?|Method)\s*[:：]?$/i.test(line)) {
      result.push({ label: line.replace(/[:：]$/, ''), text: '' });
      continue;
    }
    result.push({ label: '', text: line });
  }
  // 把短标签与它后面的内容合起来（标签块自己留不住内容）
  const merged: LabelledBlock[] = [];
  for (let at = 0; at < result.length; at += 1) {
    const block = result[at]!;
    if (block.label !== '' && block.text === '') {
      const body: string[] = [];
      let next = at + 1;
      while (next < result.length && result[next]!.label === '') {
        body.push(result[next]!.text);
        next += 1;
      }
      if (body.length > 0) {
        merged.push({ label: block.label, text: body.join('\n') });
        at = next - 1;
        continue;
      }
    }
    if (block.text !== '') merged.push(block);
  }
  return merged;
}

/** `<meta property="og:description" content="…">` 取 content（属性顺序两种写法都要认） */
function metaContent(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(html);
    if (hit?.[1]) return hit[1];
  }
  return '';
}

/** 解常见 HTML 实体（够用即可：`&amp;`/`&quot;`/`&#39;`/`&nbsp;`/数字实体） */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/** 空白折叠成单空格（去标签后会留下大片空白，不折叠会白占素材额度） */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n');
}

/**
 * 从页面里抠出 `window.__INITIAL_STATE__` 那个对象（括号配平扫描，不整页正则）。
 *
 * ⚠️ **它不是一个合法 JSON**：页面内嵌的是 JS 对象字面量，实测带裸 `undefined`
 * （`"jsAssetsList":undefined`，共 6 处）。所以先把字符串外的裸 `undefined` 换成 `null`
 * 再 `JSON.parse`——不换的话整个 parse 失败，而失败会静默回落成通用 HTML，
 * 于是从推荐流里抓到**另一道菜**（本轮实测踩过：想要「牛肉豆腐煲」拿到「黄酒煮鸡」）。
 * 宁可修字面量也不能容忍静默回落，所以这一步**与上面的配平一样是必要的**，不是容错装饰。
 */
function readInitialState(html: string): { noteData?: unknown } | undefined {
  const marker = /window\.__INITIAL_STATE__\s*=\s*\{/.exec(html);
  if (!marker) return undefined;
  const start = html.indexOf('{', marker.index + marker[0].length - 1);
  if (start < 0) return undefined;
  // 配平扫描：从 `{` 起数字符串外的花括号深度，找到闭合处再整体 JSON.parse。
  // 不能用正则去「找 `</script>`」——state 内部含转义过的 HTML（字幕/封面 URL），
  // 会出现假边界。字符串内的花括号要跳过（否则第一个 JSON 字符串里的 `}` 就提前结束）。
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < html.length; at += 1) {
    const char = html[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = html.slice(start, at + 1);
        return parseLooseJson(candidate);
      }
    }
  }
  return undefined;
}

/** 把 JS 对象字面量当 JSON 读：先把**字符串外**的裸 `undefined` 换成 `null` 再 parse */
export function parseLooseJson(text: string): { noteData?: unknown } | undefined {
  const repaired = replaceBareUndefined(text);
  try {
    return JSON.parse(repaired) as { noteData?: unknown };
  } catch {
    return undefined;
  }
}

/** 只替换**字符串外**的 `undefined`（字符串里的「undefined」是正文，不能动） */
function replaceBareUndefined(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (text.startsWith('undefined', at)) {
      out += 'null';
      at += 'undefined'.length - 1;
      continue;
    }
    out += char;
  }
  return out;
}
