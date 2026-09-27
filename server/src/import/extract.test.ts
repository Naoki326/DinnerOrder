import { describe, expect, it } from 'vitest';
import {
  clampSourceText,
  composeSourceText,
  extractFromText,
  extractFromUrl,
  MAX_SOURCE_TEXT_LENGTH,
  parseHtmlDocument,
  parseJsonLdRecipe,
  parseSrt,
  SourceTooShortError,
  SourceFetchError,
  xiaohongshuNote,
} from './extract.js';

/**
 * 取正文层的单测：**纯解析 + 注入 fetch，不碰网**。
 *
 * 与 `library/collectors.test.ts` 同一条纪律——「解析器对不对」与「今天能不能连上小红书」
 * 必须是两件独立的事。下面的 HTML/srt 夹具照**真实页面结构**手写（不是想象的形状）：
 * `__INITIAL_STATE__` 是平台内嵌的页面状态，字幕地址藏在 `video.mediaV2` 这层**字符串化的 JSON** 里。
 */

describe('parseSrt：字幕只留台词', () => {
  it('去掉序号与时间轴，保留台词顺序', () => {
    const srt = [
      '1',
      '00:00:00,590 --> 00:00:08,160',
      '姐妹们，这道豆腐牛肉煲一定要试试',
      '',
      '2',
      '00:00:08,170 --> 00:00:11,440',
      '不要高超的厨艺',
    ].join('\n');
    expect(parseSrt(srt)).toBe('姐妹们，这道豆腐牛肉煲一定要试试\n不要高超的厨艺');
  });

  it('srt 的行内换行（\\N）并成一句', () => {
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n分两次加入清水\\N朝一个方向搅')).toBe(
      '分两次加入清水 朝一个方向搅',
    );
  });
});

describe('parseHtmlDocument：通用网页的标题与正文', () => {
  const html = `<!doctype html><html><head>
    <title>牛肉豆腐煲的做法</title>
    <meta property="og:description" content="不知道吃什么的时候试试这道菜">
    <style>body{color:red}</style>
  </head><body><script>var x=1;</script><h1>牛肉豆腐煲</h1><p>牛肉切薄片，腌 15 分钟。</p></body></html>`;

  it('取标题、描述与正文文字，去脚本与样式', () => {
    const parsed = parseHtmlDocument(html);
    expect(parsed.title).toBe('牛肉豆腐煲的做法');
    expect(parsed.description).toBe('不知道吃什么的时候试试这道菜');
    expect(parsed.bodyText).toContain('牛肉切薄片，腌 15 分钟。');
    // 脚本与样式的内容不该进素材（它们不是做法信息，占了额度还误导模型）
    expect(parsed.bodyText).not.toContain('var x=1');
    expect(parsed.bodyText).not.toContain('color:red');
  });

  it('content 写在 name 前面的 meta 也认', () => {
    const flipped = '<meta content="描述在前" name="description">';
    expect(parseHtmlDocument(flipped).description).toBe('描述在前');
  });

  it('没有标题与 meta 时不报错，只是空串', () => {
    expect(parseHtmlDocument('<p>只有正文</p>')).toEqual({ title: '', description: '', bodyText: '只有正文' });
  });
});

describe('xiaohongshuNote：内嵌状态与字幕地址', () => {
  const html = `<html><body><script>window.__INITIAL_STATE__=${JSON.stringify({
    noteData: {
      title: '牛肉豆腐煲',
      desc: '不知道吃什么的时候试试这道菜 #下饭菜',
      video: {
        mediaV2: JSON.stringify({
          video: {
            subtitles: {
              'en-US': [{ url: 'https://example.com/en.srt' }],
              'zh-CN': [{ url: 'https://example.com/zh.srt' }],
            },
          },
        }),
      },
    },
  })}</script></body></html>`;

  it('读出标题、正文与中文字幕地址', () => {
    const note = xiaohongshuNote(html);
    expect(note?.title).toBe('牛肉豆腐煲');
    expect(note?.desc).toContain('下饭菜');
    // 中文档优先（英文档排在中文字幕之后）
    expect(note?.subtitleUrls).toEqual(['https://example.com/zh.srt', 'https://example.com/en.srt']);
  });

  it('不是笔记页时返回 undefined（调用方回落到通用 HTML，**不抛错**）', () => {
    expect(xiaohongshuNote('<html><body>普通网页</body></html>')).toBeUndefined();
  });

  it('mediaV2 不是合法 JSON 时正文照用、字幕为空（这一档不是失败）', () => {
    const broken = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      noteData: { title: '某道菜', desc: '正文还在', video: { mediaV2: '不是 JSON' } },
    })}</script>`;
    const note = xiaohongshuNote(broken);
    expect(note?.title).toBe('某道菜');
    expect(note?.desc).toBe('正文还在');
    expect(note?.subtitleUrls).toEqual([]);
  });

  it('状态对象里含转义 HTML 与花括号字符串时也能配平（正则切不出真边界）', () => {
    // 这一条守的是 `readInitialState` 的括号配平：字幕/封面 URL 里含 `}`、
    // 正文里含转义过的 HTML——用「找 </script>」或贪婪正则都会切错
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      noteData: { title: '含 } 的标题', desc: '<div class="x">正文</div>', video: { mediaV2: '{}' } },
      extra: { a: 1 },
    })}</script><script>after</script>`;
    const note = xiaohongshuNote(html);
    expect(note?.title).toBe('含 } 的标题');
    expect(note?.desc).toBe('<div class="x">正文</div>');
  });

  it('内嵌对象带裸 undefined（不是合法 JSON）时仍能读出笔记——本轮实测的真形状', () => {
    // 真实页面里是 JS 对象字面量，带 `"jsAssetsList":undefined` 这类裸 undefined（实测 6 处）。
    // 不修字面量 → JSON.parse 失败 → **静默回落成通用 HTML** → 从推荐流里抓到另一道菜。
    // 这条守的就是「宁可修字面量，不容忍静默抓错菜」。
    const html = `<script>window.__INITIAL_STATE__={"global":{"jsAssetsList":undefined,"a":1},${JSON.stringify(
      { noteData: { title: '牛肉豆腐煲', desc: '不知道吃什么的时候试试这道菜' } },
    ).slice(1)}</script>`;
    const note = xiaohongshuNote(html);
    expect(note?.title).toBe('牛肉豆腐煲');
    expect(note?.desc).toContain('不知道吃什么');
  });

  it('字符串里的「undefined」是正文，不能被改掉', () => {
    const html = `<script>window.__INITIAL_STATE__={"x":undefined,${JSON.stringify(
      { noteData: { title: 't', desc: '这段文字里有 undefined 这个词' } },
    ).slice(1)}</script>`;
    expect(xiaohongshuNote(html)?.desc).toBe('这段文字里有 undefined 这个词');
  });

  it('笔记数据包在路由包装里（noteData.data.noteData）也认——分享落地页的真形状', () => {
    // 实测：分享短链跟随后的落地页里，外层 `noteData` 是路由包装（拿它读 title 得到 undefined），
    // 真正的笔记在 `noteData.data.noteData`。只认浅层的话——因为现在读不出笔记就不再回落——
    // 功能会「看似能用、实际全量失败」。
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      noteData: {
        routeQuery: { app_platform: 'android' },
        data: {
          noteData: {
            title: '牛肉豆腐煲',
            desc: '不知道吃什么的时候，这样一道豆腐牛肉煲一定要试试',
            video: { mediaV2: JSON.stringify({ video: { subtitles: { 'zh-CN': [{ url: 'https://example.com/zh.srt' }] } } }) },
          },
        },
      },
    })}</script>`;
    const note = xiaohongshuNote(html);
    expect(note?.title).toBe('牛肉豆腐煲');
    expect(note?.desc).toContain('一定要试试');
    expect(note?.subtitleUrls).toEqual(['https://example.com/zh.srt']);
  });
});

describe('composeSourceText 与 clampSourceText', () => {
  it('空块不占位（不留空行，免得模型把空白当信息）', () => {
    expect(composeSourceText({ title: '牛肉豆腐煲', description: '', body: '   ', transcript: '腌 15 分钟' })).toBe(
      '牛肉豆腐煲\n腌 15 分钟',
    );
  });

  it('超长素材截断到上限并说清截了多少（不静默截）', () => {
    const long = 'x'.repeat(MAX_SOURCE_TEXT_LENGTH + 500);
    const clamped = clampSourceText(long);
    expect(clamped.text).toHaveLength(MAX_SOURCE_TEXT_LENGTH);
    expect(clamped.note).toContain(`原 ${MAX_SOURCE_TEXT_LENGTH + 500} 字`);
  });

  it('没超长时不产生 note', () => {
    expect(clampSourceText('短').note).toBe('');
  });
});

describe('parseJsonLdRecipe：跨站点的那一档（schema.org Recipe）', () => {
  const wrap = (node: unknown): string =>
    `<html><head><script type="application/ld+json">${JSON.stringify(node)}</script></head><body>x</body></html>`;

  it('最普通的一档：顶层 Recipe 带 recipeIngredient 与 recipeInstructions', () => {
    const recipe = parseJsonLdRecipe(
      wrap({
        '@type': 'Recipe',
        name: '番茄炒蛋',
        recipeIngredient: ['番茄 150 克', '鸡蛋 2 个'],
        recipeInstructions: ['番茄切块', '热锅炒蛋', '合炒出锅'],
      }),
    );
    expect(recipe?.name).toBe('番茄炒蛋');
    expect(recipe?.ingredients).toEqual(['番茄 150 克', '鸡蛋 2 个']);
    expect(recipe?.steps).toEqual(['番茄切块', '热锅炒蛋', '合炒出锅']);
  });

  it('包在 @graph 里、@type 是数组、步骤是 HowToStep 对象——都要认', () => {
    const recipe = parseJsonLdRecipe(
      wrap({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: '某菜谱站' },
          {
            '@type': ['Recipe', 'Thing'],
            name: '牛肉豆腐煲',
            recipeIngredient: ['牛肉 150 克'],
            recipeInstructions: [{ '@type': 'HowToStep', text: '牛肉切片腌制' }, { '@type': 'HowToStep', text: '砂锅焖煮' }],
          },
        ],
      }),
    );
    expect(recipe?.name).toBe('牛肉豆腐煲');
    expect(recipe?.steps).toEqual(['牛肉切片腌制', '砂锅焖煮']);
  });

  it('HowToSection 嵌套（做法分段）也要能摊平', () => {
    const recipe = parseJsonLdRecipe(
      wrap({
        '@type': 'Recipe',
        name: '分段菜',
        recipeIngredient: ['盐 3 克'],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: '准备',
            itemListElement: [{ '@type': 'HowToStep', text: '切菜' }, { '@type': 'HowToStep', text: '腌肉' }],
          },
          { '@type': 'HowToStep', text: '下锅炒' },
        ],
      }),
    );
    expect(recipe?.steps).toEqual(['切菜', '腌肉', '下锅炒']);
  });

  it('steps 是**逗号连接的编号串**（一格字符串）也要拆开——实测下厨房的真形状', () => {
    // 真形状：`0.咸蛋黄蒸熟,1.制作奶黄馅,2.小火加热…`。不拆的话整道菜只剩「1 步」，
    // 而那一步是一大块文字——很隐蔽的错（预览看着像有内容）。
    const recipe = parseJsonLdRecipe(
      wrap({
        '@type': 'Recipe',
        name: '蛋黄酥',
        recipeIngredient: ['黄油 100 克'],
        recipeInstructions: '0.咸蛋黄蒸熟压成泥,1.奶黄馅拌匀,2.小火加热炒至成团,3.分成16份',
      }),
    );
    expect(recipe?.steps).toEqual(['0.咸蛋黄蒸熟压成泥', '1.奶黄馅拌匀', '2.小火加热炒至成团', '3.分成16份']);
  });

  it('steps 是换行分隔的一整段字符串也要拆开', () => {
    const recipe = parseJsonLdRecipe(
      wrap({ '@type': 'Recipe', name: 'x', recipeIngredient: ['a'], recipeInstructions: '第一步：切\n第二步：炒' }),
    );
    expect(recipe?.steps).toEqual(['第一步：切', '第二步：炒']);
  });

  it('没有 Recipe、或 Recipe 是空壳（只有名字）时返回 undefined → 安静下沉到下一档', () => {
    expect(parseJsonLdRecipe(wrap({ '@type': 'Article', name: '一篇文章' }))).toBeUndefined();
    expect(parseJsonLdRecipe(wrap({ '@type': 'Recipe', name: '只有名字' }))).toBeUndefined();
    expect(parseJsonLdRecipe('<html><body>没有 ld+json</body></html>')).toBeUndefined();
  });

  it('ld+json 不是合法 JSON 时跳过它，不抛错', () => {
    const html = '<script type="application/ld+json">{不是 JSON</script>';
    expect(parseJsonLdRecipe(html)).toBeUndefined();
  });
});

describe('extractFromText：粘贴的文字', () => {
  it('正常文字原样成为素材，来源如实记为「粘贴的文字」', () => {
    const source = extractFromText('牛肉切薄片，加姜丝生抽腌 15 分钟，砂锅焖 5 分钟。');
    expect(source.text).toContain('腌 15 分钟');
    expect(source.sourceRef).toBe('粘贴的文字');
    expect(source.notes[0]).toContain('粘贴的文字');
  });

  it('太短就报错（与其让模型硬编一道菜，不如让他把文字贴全）', () => {
    expect(() => extractFromText('牛肉')).toThrow(SourceTooShortError);
  });
});

/**
 * 一个「像菜谱的普通网页」：正文在 `<article>` 里，带编号步骤与份量，
 * 页脚塞了推荐流的其他菜（用来自证「不整页抽」）。
 */
function genericRecipeHtml(): string {
  return [
    '<html><head><title>番茄炒蛋的做法</title>',
    '<meta property="og:description" content="十分钟的一顿家常饭"></head><body>',
    '<article>',
    '<h1>番茄炒蛋</h1>',
    '<h2>用料</h2><ul><li>番茄 150 克</li><li>鸡蛋 2 个</li><li>盐 2 克</li></ul>',
    '<h2>做法</h2><ol>',
    '<li>番茄洗净切块，鸡蛋打散加少许盐搅匀备用。</li>',
    '<li>热锅下油，油热后倒入蛋液，炒到刚凝固就盛出，别炒老。</li>',
    '<li>锅里留底油，下番茄块中火炒出汁水，加一小勺糖提味。</li>',
    '<li>倒回鸡蛋翻匀，加盐调味，撒葱花出锅。</li>',
    '</ol>',
    '</article>',
    '<footer>其他推荐菜：红烧排骨、可乐鸡翅</footer>',
    '<aside>广告位</aside>',
    '</body></html>',
  ].join('');
}

describe('extractFromUrl：注入 fetch，不碰网', () => {
  /**
   * 造一个按 URL 分发的假 fetch（记录被请求过的地址，断言「取了几跳」）。
   * 也记下**请求头**——它要过一遍 `new Request()`，因为 HTTP 头是 ByteString：
   * 带非 Latin-1 字符（比如中文）会在真 fetch 里直接抛，而假 fetch 是收不到的。
   */
  function fakeFetch(routes: Record<string, { status?: number; body: string }>): {
    fetchImpl: typeof fetch;
    requested: string[];
    headers: Headers[];
  } {
    const requested: string[] = [];
    const headers: Headers[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      const built = new Request(url, init);
      headers.push(built.headers);
      const route = routes[url];
      if (!route) return new Response('not found', { status: 404 });
      return new Response(route.body, { status: route.status ?? 200 });
    }) as typeof fetch;
    return { fetchImpl, requested, headers };
  }

  const noteHtml = `<html><body><script>window.__INITIAL_STATE__=${JSON.stringify({
    noteData: {
      title: '牛肉豆腐煲',
      desc: '不知道吃什么的时候试试这道菜',
      video: { mediaV2: JSON.stringify({ video: { subtitles: { 'zh-CN': [{ url: 'https://example.com/zh.srt' }] } } }) },
    },
  })}</script></body></html>`;

  it('笔记页：正文 + 字幕一起进素材，来源记原始链接', async () => {
    const { fetchImpl, requested } = fakeFetch({
      'https://xhslink.cn/o/abc': { body: noteHtml },
      'https://example.com/zh.srt': {
        body: '1\n00:00:01,000 --> 00:00:02,000\n分两次加入清水，朝一个方向搅',
      },
    });
    const source = await extractFromUrl('https://xhslink.cn/o/abc', { fetchImpl });
    expect(source.title).toBe('牛肉豆腐煲');
    expect(source.text).toContain('不知道吃什么的时候');
    expect(source.text).toContain('分两次加入清水');
    expect(source.sourceRef).toBe('https://xhslink.cn/o/abc');
    expect(requested).toHaveLength(2);
    expect(source.notes.join('')).toContain('按小红书读取');
  });

  it('取不到字幕不整体失败：正文照用，并说清少了什么', async () => {
    const { fetchImpl } = fakeFetch({ 'https://xhslink.cn/o/abc': { body: noteHtml } });
    const source = await extractFromUrl('https://xhslink.cn/o/abc', { fetchImpl });
    expect(source.text).toContain('不知道吃什么的时候');
    expect(source.notes.join('')).toContain('一条字幕没取到');
  });

  it('请求头是纯 ASCII：带中文的 UA 会让真 fetch 直接抛（实测踩过）', async () => {
    // HTTP 头是 ByteString，非 Latin-1 字符在真 fetch 里抛「Cannot convert argument to a ByteString」。
    // 用 `new Request()` 把头部序列化一遍就是同一道闸门——假 fetch 本来收不到这个错，
    // 所以这条断言是那不兼容的唯一防线。
    const { fetchImpl, headers } = fakeFetch({
      'https://example.com/dish': { body: genericRecipeHtml() },
    });
    await extractFromUrl('https://example.com/dish', { fetchImpl });
    const ua = headers[0]!.get('user-agent') ?? '';
    expect(ua).not.toBe('');
    expect(/^[\x20-\x7e]*$/.test(ua)).toBe(true);
  });

  it('被重定向到登录页：报「要登录」，而不是把登录页当素材', async () => {
    // 小红书对非浏览器 UA / 未登录的请求就是这么处理的（302 → /login 且返回 200）。
    // 不报的话拿到的是登录页，模型要么编一道菜、要么报个说不清的形状错误（实测踩过）。
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      // Response.url 模拟跟随重定向后的最终地址
      const response = new Response(`<html><body><script>window.__INITIAL_STATE__={"noteData":null}</script>登录后查看</body></html>`);
      Object.defineProperty(response, 'url', { value: 'https://www.xiaohongshu.com/login?redirectPath=%2F' });
      return response;
    }) as typeof fetch;

    await expect(extractFromUrl('https://xhslink.cn/o/abc', { fetchImpl })).rejects.toThrow(/要登录/);
  });

  it('普通网页按通用档读：只收 article 正文，且说明凭什么认为它是菜谱', async () => {
    const { fetchImpl } = fakeFetch({ 'https://example.com/dish': { body: genericRecipeHtml() } });
    const source = await extractFromUrl('https://example.com/dish', { fetchImpl });
    expect(source.title).toBe('番茄炒蛋的做法');
    expect(source.text).toContain('番茄洗净切块');
    // 「为什么认为这是菜谱」必须说出来（不静默放行）
    expect(source.notes.join('')).toMatch(/按网页正文读取（正文 \d+ 字，含/);
    // 正文之外的页脚/推荐流不该进素材
    expect(source.text).not.toContain('其他推荐菜');
  });

  it('通用档：正文里找不到步骤与份量时**报错**（不硬喂给模型）', async () => {
    // 实测的形状：B 站视频页只有标题与评论，做法不在 DOM 里
    const { fetchImpl } = fakeFetch({
      'https://example.com/video': {
        body: `<html><head><title>某视频</title></head><body><article>${'这是一个视频页面，做法在视频里，文字部分只有简介与评论。'.repeat(3)}</article></body></html>`,
      },
    });
    await expect(extractFromUrl('https://example.com/video', { fetchImpl })).rejects.toThrow(/看不出是菜谱/);
  });

  it('429 不换 UA 重试（那会加剧限流），直接如实报并给出下一步', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response('slow down', { status: 429 });
    }) as typeof fetch;
    await expect(extractFromUrl('https://example.com/hot', { fetchImpl })).rejects.toThrow(/限流/);
    // 只请求了一次（没有为换 UA 再打一次）
    expect(requested).toHaveLength(1);
  });

  it('页面取不到就报错（界面据此提示改用贴文字）', async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(extractFromUrl('https://example.com/gone', { fetchImpl })).rejects.toThrow(SourceFetchError);
  });

  it('HTTP 报错也报出来，不把错误页当素材', async () => {
    const { fetchImpl } = fakeFetch({ 'https://example.com/403': { status: 403, body: 'forbidden' } });
    await expect(extractFromUrl('https://example.com/403', { fetchImpl })).rejects.toThrow(/HTTP 403/);
  });

  it('页面取到了但内容太少也报错（不是「空白素材」硬喂给模型）', async () => {
    const { fetchImpl } = fakeFetch({ 'https://example.com/empty': { body: '<html><body>暂无</body></html>' } });
    // 这种壳页在通用档就被证据闸门拦下了（比「太短」更准的说法：看不出是菜谱）
    await expect(extractFromUrl('https://example.com/empty', { fetchImpl })).rejects.toThrow(/看不出是菜谱/);
  });

  it('小红书链接没读出笔记结构时**报错，不回落到通用 HTML**', async () => {
    // 笔记页的通用 HTML 里含推荐流的**其他笔记**（实测：想要「牛肉豆腐煲」拿到「黄酒煮鸡」）。
    // 宁可报错让他贴文字，也不把一道错的菜送进家庭菜谱库（它会一路进推荐池）。
    const { fetchImpl } = fakeFetch({
      'https://www.xiaohongshu.com/discovery/item/abc': {
        body: '<html><body>登录 推荐流里有 黄酒煮鸡 的做法 <p>另外一道菜的做法</p></body></html>',
      },
    });
    await expect(extractFromUrl('https://www.xiaohongshu.com/discovery/item/abc', { fetchImpl })).rejects.toThrow(
      /结构变了或需要登录/,
    );
  });

  it('非小红书链接仍然回落到通用档（那条路有用，不能一起禁掉）', async () => {
    const { fetchImpl } = fakeFetch({ 'https://example.com/dish': { body: genericRecipeHtml() } });
    const source = await extractFromUrl('https://example.com/dish', { fetchImpl });
    expect(source.text).toContain('番茄洗净切块');
    expect(source.notes.join('')).toContain('按网页正文读取');
  });
});
