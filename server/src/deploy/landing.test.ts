import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANDING_PAGE_ICON, defaultLandingEntries, renderLandingPage, svgDataUri } from './landing.js';

/**
 * 8080 的导航页（「本地服务统一入口」）。
 *
 * 它值得测试的地方不是样式好不好看，而是**几条容易静默丢掉的约束**：
 *
 * 1. **加自己的条目不能吃掉别人的**：那一页是宿主机上**所有**服务的入口，
 *    任何改动都必须保留既有的那些条目——少一条就是「某个 app 从此没有入口」，
 *    而这种事没人会立刻发现（那个 app 自己还能直连原端口）。
 * 2. **页签图标必须显式声明**：不声明时浏览器会去要 origin 根的 `/favicon.ico`，
 *    而那属于 pi-web——导航页的页签会显示**别的 app 的图标**（实测过）。
 * 3. **页签图标必须是 data URI，不能是相对路径的文件**：`/apps/` 下有 catch-all
 *    （`location /apps/ { return 404 … }`），`/apps/icon.svg` 这种会直接被 404 —— 实测过。
 * 4. **条目图标同理内嵌**：导航页的作用是「某个 app 挂了也能从这里进」，
 *    让它去引用那个 app 自己的静态资源就本末倒置了。
 */

const INPUT = { mountPath: '/apps/dinner', appIcon: 'data:image/png;base64,AAAA', subPathPort: 8786 };

describe('导航页条目', () => {
  it('家餐桌排在最前（每天用的那个），指向子路径实例', () => {
    const entries = defaultLandingEntries(INPUT);

    expect(entries[0]?.name).toBe('家餐桌');
    expect(entries[0]?.href).toBe('/apps/dinner/');
    expect(entries[0]?.chip).toBe('8786');
  });

  it('原宿主上的条目一条不少（不能因为加自己的入口吃掉别人的）', () => {
    const hrefs = defaultLandingEntries(INPUT).map((entry) => entry.href);

    // 这几条是改动前导航页上本来就有的
    expect(hrefs).toContain('/apps/pi/');
    expect(hrefs).toContain('/apps/mdtools/');
    expect(hrefs).toContain('/apps/baby/');
    expect(hrefs).toContain('/apps/frame/');
    expect(hrefs).toContain('/apps/qqmusic/');
    expect(hrefs).toContain('/xiaozhi/config/');
    expect(hrefs).toContain('/xiaozhi/camera/');
    // 一共 8 条：家餐桌 + 上游那 7 条
    expect(hrefs).toHaveLength(8);
  });

  it('每条都有分组（分组是排版的基础，缺了会让条目挤进上一个组的标题下）', () => {
    for (const entry of defaultLandingEntries(INPUT)) {
      expect(entry.group.length, entry.name).toBeGreaterThan(0);
    }
  });

  it('挂载点变了条目跟着变（生成器不写死 /apps/dinner）', () => {
    const entries = defaultLandingEntries({ ...INPUT, mountPath: '/dinner' });

    expect(entries[0]?.href).toBe('/dinner/');
  });

  it('端口只在右侧小标签里出现一次（副标题不该再重复一遍端口）', () => {
    const dinner = defaultLandingEntries(INPUT)[0];

    expect(dinner?.note).not.toContain('8786');
    expect(dinner?.chip).toBe('8786');
  });
});

describe('导航页 HTML', () => {
  const entries = defaultLandingEntries(INPUT);
  const html = renderLandingPage({ entries, listenPort: 8080 });

  it('显式给了页签图标（否则浏览器会去要 origin 根那份，属于别的 app）', () => {
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml;base64,/);
  });

  it('页签图标是 data URI：相对路径的文件会被 /apps/ 的 catch-all 404 掉', () => {
    const href = /<link rel="icon" href="([^"]+)"/.exec(html)?.[1] as string;

    expect(href.startsWith('data:')).toBe(true);
    // 不能指向任何会落到 catch-all 的路径
    expect(html).not.toContain('href="./icon');
    expect(html).not.toContain('href="/apps/icon');
  });

  it('页面顶部也有那个图标（不只页签里那份）', () => {
    expect(html).toContain('<header>');
    expect(html).toMatch(/<header>[\s\S]*?<img src="data:image\/svg\+xml;base64,/);
  });

  it('家餐桌条目带内嵌图标，且不是指向外部的 /icons/ 路径', () => {
    expect(html).toContain('data:image/png;base64,AAAA');
    // 导航页不该依赖任何 app 自己的静态资源（那个 app 可能正挂着）
    expect(html).not.toMatch(/src="\/icons\//);
  });

  it('分组标题都渲染出来了，且每种只出现一次（不重复堆标题）', () => {
    const groups = [...new Set(entries.map((entry) => entry.group))];
    for (const group of groups) {
      const count = html.split(`<h2>${group}</h2>`).length - 1;
      expect(count, group).toBe(1);
    }
  });

  it('端口与标题分别渲染（端口进小标签，标题里不再拼一长串）', () => {
    // 上游那版把「/apps/pi/ → 30141」写在一行里；现在端口单独成标签
    expect(html).toContain('<span class="chip">30141</span>');
    expect(html).not.toContain('→ 30141');
  });

  it('长名字用 ellipsis 截断而不是换行（换行会让卡片高矮不一）', () => {
    expect(html).toContain('text-overflow:ellipsis');
    expect(html).toContain('white-space:nowrap');
  });

  it('所有条目都渲染出来了（逐条出现，不丢）', () => {
    for (const entry of entries) {
      expect(html).toContain(`href="${entry.href}"`);
    }
  });

  it('文案里的尖括号被转义（条目文案最终会进 HTML 属性与正文）', () => {
    const escaped = renderLandingPage({
      entries: [{ group: 'g', href: '/x/', name: '<script>坏</script>', note: 'a & b' }],
      listenPort: 8080,
    });

    expect(escaped).not.toContain('<script>坏');
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).toContain('a &amp; b');
  });

  it('只有 emoji 的条目渲染 emoji、不渲染空 img', () => {
    const plain = renderLandingPage({
      entries: [{ group: 'g', href: '/x/', name: 'x', emoji: '🎵' }],
      listenPort: 8080,
    });

    expect(plain).toContain('🎵');
    // 只看**条目那一行**：页面顶部还有一份页签图标用的 <img>，别把它算进来
    const row = plain.split('\n').find((line) => line.includes('class="app"')) as string;
    expect(row).not.toContain('<img');
  });

  it('既没图标也没 emoji 也不崩（只有文字）', () => {
    const plain = renderLandingPage({ entries: [{ group: 'g', href: '/x/', name: 'x' }], listenPort: 8080 });

    expect(plain).toContain('href="/x/"');
    const row = plain.split('\n').find((line) => line.includes('class="app"')) as string;
    // 没有图形位时连 tile 壳都不该出现（否则会留一个空方块）
    expect(row).not.toContain('<img');
    expect(row).not.toContain('class="tile"');
  });

  it('是手机可读的（有 viewport，且宽度自适应不横向溢出）', () => {
    expect(html).toContain('width=device-width');
    expect(html).toContain('max-width:680px');
  });
});

describe('data URI', () => {
  it('base64 编码（URI 编码会让 # 与引号在 HTML 属性里出问题）', () => {
    const uri = svgDataUri('<svg fill="#2563eb"/>');

    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(uri).not.toContain('#');
    expect(Buffer.from(uri.split(',')[1] as string, 'base64').toString('utf8')).toBe('<svg fill="#2563eb"/>');
  });
});

describe('内嵌前的 SVG 瘦身', () => {
  it('去掉 XML 注释（源文件顶着一大段设计注释，内嵌进 HTML 属性只会把属性撑得没法读）', () => {
    const svg = '<svg><!-- 很长很长的一段设计说明\n还可能换行 --><rect width="64" height="64"/></svg>';

    const decoded = Buffer.from(svgDataUri(svg).split(',')[1] as string, 'base64').toString('utf8');

    expect(decoded).not.toContain('设计说明');
    expect(decoded).toContain('<rect width="64" height="64"/>');
  });

  it('剥注释后仍是合法 SVG（渲染不受影响）', () => {
    const decoded = Buffer.from(
      svgDataUri('<svg><!-- c --><circle r="1"/></svg>').split(',')[1] as string,
      'base64',
    ).toString('utf8');

    expect(decoded.startsWith('<svg>')).toBe(true);
    expect(decoded.endsWith('</svg>')).toBe(true);
    expect(decoded).toContain('<circle r="1"/>');
  });

  it('真的把包体积降下来了（家餐桌的真源图标内嵌后不该上千字节）', () => {
    const real = fs.readFileSync(path.join(process.cwd(), '..', 'web', 'public', 'icons', 'icon.svg'), 'utf8');

    const decoded = Buffer.from(svgDataUri(real).split(',')[1] as string, 'base64').toString('utf8');

    expect(decoded.length).toBeLessThan(600);
    expect(decoded).toContain('viewBox="0 0 512 512"');
  });
});

describe('导航页自己的图标', () => {
  it('是 blue 底 + 四格（不是某个具体 app 的配色：这页是所有服务的入口）', () => {
    expect(LANDING_PAGE_ICON).toContain('fill="#2563eb"');
    // 四个 rect = 四格
    expect((LANDING_PAGE_ICON.match(/<rect /g) ?? []).length).toBe(5); // 1 个底 + 4 个格子
  });

  it('磁贴够大够分开（16px 页签下要能看出是四格，而不是一块模糊的蓝方块）', () => {
    // 格子 19 单位 / 间隙 4 单位（64 网格）：实测这组数值在 16px 下四格分得开
    const tiles = [...LANDING_PAGE_ICON.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/g)];

    expect(tiles.length).toBe(4);
    for (const tile of tiles) {
      expect(Number(tile[3])).toBeGreaterThanOrEqual(18);
    }
  });
});
