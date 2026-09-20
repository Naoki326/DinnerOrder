/**
 * 8080 导航页（`location = /apps/` 那个「本地服务统一入口」）的生成器。
 *
 * ## 为什么它必须进仓库
 *
 * 那一页的真实文件原先只活在 `/opt/homebrew/Cellar/nginx/<版本>/html/index.html` 里，
 * 而 **Cellar 的版本目录是 nginx 一升级就换的**——也就是说「宿主机上有哪些入口」这件事，
 * 在 `brew upgrade nginx` 之后会静默丢回旧样子（或者干脆 404，看新版本带不带 html/）。
 * 本仓库的部署约定是「宿主配置只留一行 include，产物本体受版本控制」（见 `nginx.ts`），
 * 导航页同理：生成器与产物都在仓库里，`pnpm deploy:install` 每次都把它恢复成应然的样子。
 *
 * 光把文件写过去还不够：`root html` 会把请求解析到版本目录去，所以 `install` 同时把那个
 * location 的 `root` 指到 `<nginx 配置目录>/landing`（稳定目录，Homebrew 升级不动它）——
 * 见 `nginx-include.ts` 的 `retargetLandingRoot`。
 *
 * ## 图标
 *
 * 导航页本身与每个条目都带图标：
 *   * **导航页自己的页签图标**必须显式声明。不声明时浏览器只会去要 origin 根的 `/favicon.ico`，
 *     而 8080 那个地址属于 pi-web——导航页的页签会显示**别的 app 的图标**（实测过）。
 *   * **条目的图标用 data URI 内嵌**，不引用各 app 自己的 `/icons/...`：导航页的作用恰恰是
 *     「某个 app 挂了也能从这里进」，让它的渲染依赖那个挂着的 app 就本末倒置了。
 */
import path from 'node:path';

/** `root` 那一行上的标记（装机与还原都认它，幂等的关键） */
export const LANDING_ROOT_MARKER = '# dinnerorder-landing-root';

/** 把 SVG 转成 data URI（base64 而非 URL 编码：`#` 与引号在 HTML 属性里要转义，base64 免了这层） */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(stripSvgComments(svg), 'utf8').toString('base64')}`;
}

/**
 * 去掉 SVG 里的 XML 注释再内嵌。
 *
 * 图标源文件（`web/public/icons/icon.svg`）顶着一段挺长的中文设计注释——那对**看源码**的人是
 * 有价值的信息，但内嵌进导航页的 HTML 属性就是把几千字节的 base64 挞到每一份页面里，
 * 而且让源码里的那个属性完全没法读。渲染不需要注释，所以内嵌前去掉。
 */
export function stripSvgComments(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\n\s*\n/g, '\n').trim();
}

/**
 * 导航页自己的页签图标：四格「应用启动台」。
 *
 * 用页面自己的链接蓝（`#2563eb`）而不是家餐桌的暖橙：这一页是**所有服务**的入口，
 * 用某个具体 app 的配色会显得那一页是那个 app 的。四格是「一堆入口」的通用隐喻。
 *
 * 尺寸按一样的两条硬约束定（16px 页签）：512÷16=32，所以 1 屏幕像素 = 4 个 SVG 单位（这里用 64 网格）；
 * 磁贴之间必须留得开——实测把 15 宽的磁贴改成 19、间隙从 6 收到 4 之后，
 * 16px 下四面四格才分得清楚（先前那版磁贴偏小，缩下来像一块模糊的蓝方块）。
 */
export const LANDING_PAGE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="15" fill="#2563eb"/><g fill="#fff"><rect x="11" y="11" width="19" height="19" rx="5.5"/><rect x="34" y="11" width="19" height="19" rx="5.5"/><rect x="11" y="34" width="19" height="19" rx="5.5"/><rect x="34" y="34" width="19" height="19" rx="5.5"/></g></svg>`;

export interface LandingEntry {
  href: string;
  /** 主标题（原样保留宿主上已有的那些文案） */
  name: string;
  /** 副标题：一句人话说明这是什么。省略就不渲染那行 */
  note?: string;
  /** 右侧小标签：端口或地址（等宽字体，方便一眼扫过去找端口） */
  chip?: string;
  /** 条目图标（data URI）。与 `emoji` 二选一，`icon` 优先 */
  icon?: string;
  /** 没有真图标时的兑底图形 */
  emoji?: string;
  /** 分组名（相同分组聚在一起，按出现顺序排） */
  group: string;
}

export interface LandingEntryInput {
  /** 家餐桌的挂载前缀（来自装机计划，改 `--mount` 时这里跟着变） */
  mountPath: string;
  /** 家餐桌的页签图标（data URI） */
  appIcon: string;
  /** 子路径实例的端口（家餐桌经 nginx 反代的那个） */
  subPathPort: number;
}

/**
 * 导航页上的条目：家餐桌排在最前（一家人每天用的那个），其余原样保留。
 *
 * 「其余原样保留」是硬要求：这一页是宿主机上**所有**服务的入口，改它的人只该加自己那条。
 * 分组是把宿主上本来就有的那些服务按**用途**归堆（家庭日常 / 设备与媒体 / 工具与开发），
 * 8 条平铺在一页时找东西靠扫，分了组就是找标题——手机上尤其明显。
 */
export function defaultLandingEntries(input: LandingEntryInput): LandingEntry[] {
  return [
    {
      group: '家庭日常',
      href: `${input.mountPath}/`,
      name: '家餐桌',
      note: '家常菜预定与买菜清单',
      chip: String(input.subPathPort),
      icon: input.appIcon,
    },
    { group: '家庭日常', href: '/apps/baby/', name: 'baby-care-bridge', chip: '8000', emoji: '🍼' },
    { group: '家庭日常', href: '/apps/frame/', name: 'FramedPhoto 管理台', note: '相框照片', chip: '8010', emoji: '🖼' },

    { group: '设备与媒体', href: '/apps/qqmusic/', name: 'QQ 音乐授权', note: '小智点歌凭证', chip: '8777', emoji: '🎵' },
    { group: '设备与媒体', href: '/xiaozhi/config/', name: '小智设备配置', chip: '8003', emoji: '🔧' },
    {
      group: '设备与媒体',
      href: '/xiaozhi/camera/',
      name: '小智摄像头监控',
      note: '设备直连 xiaozhi-8144.local',
      emoji: '📷',
    },

    { group: '工具与开发', href: '/apps/pi/', name: 'pi-web', note: 'AI 对话', chip: '30141', emoji: '🥧' },
    { group: '工具与开发', href: '/apps/mdtools/', name: 'ClaudeMdTools 知识库', chip: '30142', emoji: '📚' },
  ];
}

/** 导航页所在目录（nginx 配置目录下的 `landing/`：稳定目录，Homebrew 升级不动） */
export function landingDir(nginxConfDir: string): string {
  return path.join(nginxConfDir, 'landing');
}

/** 导航页文件路径（就是上面那个 location 的 `root` + `try_files /index.html`） */
export function landingIndexPath(nginxConfDir: string): string {
  return path.join(landingDir(nginxConfDir), 'index.html');
}

/** HTML 文本转义（条目文案是宿主机上来的，虽然是我们自己写的，但转义是零成本的自保） */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 生成导航页 HTML。
 *
 * 排版取向（手机上看的，一家人在手机里点）：
 *   * **分组**：标题小、字距松，把 8 条平铺变成「找标题」而不是「逐条扫」。
 *   * **一行一条、图标居左、端口做右侧小标签**：端口是排查时才要的信息，
 *     不该占着副标题的位置抢注意力——而它又是「这个服务到底在跑没跑」的第一手线索，
 *     所以留在右侧但用等宽小字。
 *   * **长名字截断**：`FramedPhoto 管理台` / `ClaudeMdTools 知识库` 在窄屏上会把右侧标签挤走，
 *     用 ellipsis 而不是换行（换行会让卡片高矮不一，一页里看着很乱）。
 */
export function renderLandingPage(options: {
  entries: LandingEntry[];
  /** 8080 的监听端口，写在标题里（原来那版就写着） */
  listenPort: number;
  /** 导航页自己的页签图标；不传用默认那份 */
  pageIcon?: string;
}): string {
  const pageIcon = svgDataUri(options.pageIcon ?? LANDING_PAGE_ICON);

  // 分组按**首次出现的顺序**排（不另立一张分组表：加条目的人只该关心自己那条摆在哪）
  const groups: { name: string; entries: LandingEntry[] }[] = [];
  for (const entry of options.entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === entry.group) last.entries.push(entry);
    else groups.push({ name: entry.group, entries: [entry] });
  }

  const sections = groups
    .map((group) => {
      const items = group.entries
        .map((entry) => {
          const tile =
            entry.icon !== undefined
              ? `<span class="tile"><img src="${escapeHtml(entry.icon)}" alt="" width="34" height="34"></span>`
              : entry.emoji !== undefined
                ? `<span class="tile">${escapeHtml(entry.emoji)}</span>`
                : '';
          const note = entry.note === undefined ? '' : `<small>${escapeHtml(entry.note)}</small>`;
          const chip = entry.chip === undefined ? '' : `<span class="chip">${escapeHtml(entry.chip)}</span>`;
          return `      <a class="app" href="${escapeHtml(entry.href)}">${tile}<span class="txt"><b>${escapeHtml(entry.name)}</b>${note}</span>${chip}</a>`;
        })
        .join('\n');
      return `    <h2>${escapeHtml(group.name)}</h2>\n${items}`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>本地服务统一入口</title>
<!-- 显式声明页签图标：不声明时浏览器会去要 origin 根的 /favicon.ico，而那属于 pi-web -->
<link rel="icon" href="${pageIcon}">
<style>
  :root{--blue:#2563eb;--ink:#111;--sub:#8a8a8a;--line:#e6e6e6}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;max-width:680px;margin:0 auto;
       padding:28px 16px 44px;line-height:1.6;background:#fafafa;color:var(--ink);-webkit-text-size-adjust:100%}
  header{display:flex;align-items:center;gap:12px;margin:0 2px 4px}
  header img{width:42px;height:42px;border-radius:11px;flex:none}
  h1{font-size:19px;font-weight:650;margin:0;letter-spacing:-.01em}
  header p{margin:1px 0 0;color:var(--sub);font-size:12.5px}
  h2{font-size:11.5px;font-weight:600;color:#9a9a9a;letter-spacing:.09em;margin:26px 2px 8px}
  a.app{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--line);
        border-radius:12px;padding:11px 13px;margin:8px 0;color:var(--ink);text-decoration:none;
        box-shadow:0 1px 2px rgba(0,0,0,.03)}
  a.app:hover{border-color:var(--blue)}
  .tile{width:34px;height:34px;border-radius:9px;flex:none;display:grid;place-items:center;
        font-size:17px;background:#f1f5ff}
  .tile img{width:34px;height:34px;border-radius:9px;display:block}
  .txt{min-width:0;flex:1}
  .txt b{display:block;font-size:15.5px;font-weight:600;color:var(--blue);
         white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .txt small{display:block;color:var(--sub);font-size:12.5px;
         white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chip{font:.72rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#666;background:#f4f4f5;
        border-radius:999px;padding:5px 9px;flex:none}
  footer{margin:28px 2px 0;color:#b0b0b0;font-size:12px}
</style>
</head>
<body>
<header>
  <img src="${pageIcon}" alt="" width="42" height="42">
  <div>
    <h1>本地服务统一入口</h1>
    <p>${options.listenPort} 端口 · ${options.entries.length} 个服务</p>
  </div>
</header>
${sections}
<footer>各服务原端口仍可直接访问；本页由 <code>pnpm deploy:install</code> 生成。</footer>
</body>
</html>
`;
}
