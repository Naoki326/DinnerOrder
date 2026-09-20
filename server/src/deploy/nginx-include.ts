/**
 * 把本 app 的 location 接进**宿主机已有的 8080 server block**（用户口径：并入 `/apps/` 家族）。
 *
 * ## 为什么不是「写一个 servers/dinner.conf」
 *
 * `nginx.conf` 末尾是 `include servers/*;`，**在 `http {}` 里**——所以 `servers/` 下每个文件
 * 是 http 上下文（要自带 `server { }`），而用户要的是并入已有的 8080 块（`servers/apps-proxy.conf`，
 * 那里用 `/apps/xxx/` 前缀区分 pi-web / mdtools / baby / frame / qqmusic）。一个 `location`
 * 必须落在某个 `server` 里，所以只有两条路：
 *
 *   (a) 往 `apps-proxy.conf` 里**插几行**；或
 *   (b) 让那个文件 `include` 一个独立文件（片段仍在仓库里被版本控制）。
 *
 * 本模块选 **(b)**：`apps-proxy.conf` 是用户手写的、服务多个 app，直接插进去的片段
 * 在下次人工编辑时极易被误删；`include` 一行是**幂等且可撤销**的，片段本身留在仓库里。
 * 卸载时把那行 include 去掉（片段文件也跟着删）。
 *
 * ## 插入位置
 *
 * 用 `listen 8080;` 定位那个 server block，再**按大括号配平**找它的收尾 `}`，在那之前插入。
 * 不用正则一把梭：这个文件里有引号含 `{`/`}` 的字符串（如 `return 200 '<!doctype…'`）与
 * 注释里的花括号（如 `map ... { ... }` 被注释掉的那行），按行配平时会先把注释与字符串剥掉。
 * 这些都是真实存在的陷阱，所以配平逻辑单独可测。
 */
import fs from 'node:fs';
import path from 'node:path';

/** `include` 那一行里用来识别「这是我们插的」的标记（幂等的关键） */
export const INCLUDE_MARKER = '# dinnerorder-location';

/** 片段文件名（与 include 一起放 `servers/`） */
export const FRAGMENT_NAME = 'dinner-location.conf';

/**
 * 剥掉一行里的注释与字符串内容，只留下真正参与大括号配平的部分。
 *
 * nginx 的注释以 `#` 开头（引号内的 `#` 不算注释，如 `color:#888`），字符串是单/双引号。
 * 这里的目的是**配平**，不是解析 nginx——把字符串与注释内容换成等长空格，
 * 行内其余字符原样保留（含 `{`/`}`）。
 */
export function stripForBalance(line: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote !== undefined) {
      out += ' ';
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      // 注释吞掉本行剩余部分
      out += ' '.repeat(line.length - i);
      break;
    }
    out += ch;
  }
  return out;
}

/**
 * 找到 `listen <port>;` 所在 server block 的收尾 `}` 的**行号**（1 起算）。
 *
 * `port` 是 **nginx 自己的监听端口**（本机是 8080），不是 app 的端口（8787）——
 * 两者极易混：传成 app 端口会报「找不到 listen 8787;」，而那句话听起来像是「nginx 没监听 app 端口」，
 * 实际只是参数用错了。所以这里刻意把参数名叫 `listenPort` 而不是 `port`。
 *
 * 找不到就报错：宁可装机时报错让人看见，也不要悄悄插到错位置（那会让整份 nginx 配置崩掉，
 * 连带影响用户其他 app）。
 */
export function findServerBlockEnd(lines: string[], listenPort: number): number {
  const listenIndex = lines.findIndex((line) =>
    new RegExp(`^\\s*listen\\s+${listenPort}\\s*;`).test(stripForBalance(line)),
  );
  if (listenIndex === -1) throw new Error(`宿主 nginx 里找不到 listen ${listenPort}; 的 server block`);

  // 从 listen 行往上找该 server 的 `server {`
  let startIndex = -1;
  for (let i = listenIndex; i >= 0; i -= 1) {
    const stripped = stripForBalance(lines[i] as string);
    if (/\bserver\s*\{/.test(stripped)) {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) throw new Error(`listen ${listenPort}; 之前找不到 server { 开头`);

  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const ch of stripForBalance(lines[i] as string)) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  throw new Error(`listen ${listenPort}; 的 server block 大括号不配平，拒绝改动`);
}

/** 这段配置里是否已经有我们的 include（幂等判据） */
export function hasDinnerInclude(text: string): boolean {
  return text.includes(INCLUDE_MARKER);
}

/**
 * 在 `listen listenPort;` 的 server block 末尾插入 include 行。
 *
 * 幂等：已经有 include 时原样返回（`changed: false`）。这样重复装机不会堆积多行 include。
 */
export function insertDinnerInclude(
  text: string,
  fragmentPath: string,
  listenPort: number,
): { text: string; changed: boolean } {
  if (hasDinnerInclude(text)) return { text, changed: false };

  const lines = text.split('\n');
  const endIndex = findServerBlockEnd(lines, listenPort);
  const indent = /\s*/.exec(lines[endIndex] as string)?.[0] ?? '';
  const includeLine = `${indent}include ${fragmentPath};     ${INCLUDE_MARKER}`;

  // 插在收尾 `}` 之前一行，并在前面留一个空行（可读性：不与上一段配置黏在一起）
  const next = [...lines.slice(0, endIndex), '', includeLine, ...lines.slice(endIndex)];
  return { text: next.join('\n'), changed: true };
}

/** 撤掉我们插入的 include 行（幂等：没有就原样返回） */
export function removeDinnerInclude(text: string): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const kept = lines.filter((line) => !line.includes(INCLUDE_MARKER));
  if (kept.length === lines.length) return { text, changed: false };
  // 连同插入时补的那个空行一起去掉，避免反复装/卸留下空行堆积
  const cleaned: string[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i] as string;
    const nextLine = kept[i + 1];
    if (line.trim() === '' && nextLine !== undefined && nextLine.trim() === '}') continue;
    cleaned.push(line);
  }
  return { text: cleaned.join('\n'), changed: true };
}

/**
 * 把片段与 include 一起装进宿主 nginx（片段文件 + include 行 + `nginx -t` 验证）。
 *
 * `include` 用的是**绝对路径**：nginx 的 include 相对 `prefix`（`nginx -p`）解析，
 * 而宿主实例的 prefix 是 `/opt/homebrew/etc/nginx`——写相对路径时它会去
 * `servers/servers/` 找，报一个指不到真因的「文件不存在」。
 */
export function installIntoExistingServer(options: {
  confPath: string;
  fragmentPath: string;
  fragment: string;
  /** 宿主 nginx 的监听端口（本机 8080），**不是** app 的端口 */
  listenPort: number;
}): { fragmentWritten: boolean; includeAdded: boolean } {
  const original = fs.readFileSync(options.confPath, 'utf8');
  fs.writeFileSync(options.fragmentPath, options.fragment);
  const { text, changed } = insertDinnerInclude(original, options.fragmentPath, options.listenPort);
  if (changed) fs.writeFileSync(options.confPath, text);
  return { fragmentWritten: true, includeAdded: changed };
}

/**
 * 撤掉（幂等）。
 *
 * **不删片段文件**：`deploy/nginx/dinner-location.conf` 是**受版本控制**的仓库文件
 * （`nginx.ts` 生成后落库，随仓库走），不是我们的临时产物。卸载只该撤掉写进宿主那行 include，
 * 删掉仓库里的文件会把工作区弄脏（`git status` 出现一次意外删除）。
 * 同理，`install` 失败时的回滚也只撤 include（`repoFragmentPath` 那份文件本来就会被重写）。
 */
export function uninstallFromExistingServer(options: { confPath: string }): {
  includeRemoved: boolean;
} {
  const original = fs.readFileSync(options.confPath, 'utf8');
  const { text, changed } = removeDinnerInclude(original);
  if (changed) fs.writeFileSync(options.confPath, text);
  return { includeRemoved: changed };
}

/** 片段在仓库里的路径（`include` 指向它；不复制到宿主目录，避免两份真相漂移） */
export function repoFragmentPath(root: string): string {
  return path.join(root, 'deploy', 'nginx', FRAGMENT_NAME);
}

/** 宿主 nginx 的统一入口监听端口（本机 8080）。可用 `NGINX_LISTEN` 覆盖 */
export const DEFAULT_NGINX_LISTEN_PORT = 8080;

/** 导航页 location 的行标记。**必须带 `#`**：这是 nginx 配置文件，不带注释符时
 *  它会被当成一条指令直接报 `unknown directive`（实测踩过，幸好 `-t` 拦下了）。 */
const LANDING_ROOT_TAG = '# dinnerorder-landing-root';

/**
 * 把导航页（`location = /apps/`）的 `root` 从 nginx 的**版本目录**改到稳定目录。
 *
 * ## 为什么必须改
 *
 * 宿主原配置是 `location = /apps/ { root html; try_files /index.html =404; }`，
 * 而 `root html` 相对 nginx 的 **prefix** 解析 —— 本机 prefix 是
 * `/opt/homebrew/Cellar/nginx/1.31.3`，于是导航页真身在
 * `/opt/homebrew/Cellar/nginx/1.31.3/html/index.html`。**那个路径带版本号**：
 * `brew upgrade nginx` 之后目录换成新版号，我们对导航页的改动就**静默消失**了
 * （若新版没带 `html/`，甚至连导航页都 404）。
 *
 * 所以装机时把它指到 `<nginx 配置目录>/landing`（`/opt/homebrew/etc/nginx/landing`）——
 * 配置目录不经 Homebrew 升级换名，导航页 HTML 放那里才稳。
 *
 * ## 为什么用绝对路径
 *
 * `root` 相对 prefix 解析那件事本身就不直观；写绝对路径后，读配置的人一眼看得出
 * 导航页在哪，不受 `nginx -p` 影响。
 *
 * 幂等：已经改过（带标记）就不再动；没找到那个 location 就返回 `changed: false`
 * （导航页不是本 app 的必需品，不该因它装不上）。
 */
export function retargetLandingRoot(
  text: string,
  absoluteDir: string,
): { text: string; changed: boolean } {
  if (text.includes(LANDING_ROOT_TAG)) return { text, changed: false };

  const lines = text.split('\n');
  // 找 `location = /apps/ {` 那一段里的 `root html;`
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/location\s*=\s*\/apps\/\s*\{/.test(stripForBalance(lines[i] as string))) {
      start = i;
      break;
    }
  }
  if (start === -1) return { text, changed: false };

  // 在该 location 的大括号范围内找 root 行（配平，不越过块尾）
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const stripped = stripForBalance(lines[i] as string);
    if (/^\s*root\s+html\s*;/.test(stripped)) {
      const indent = /\s*/.exec(lines[i] as string)?.[0] ?? '';
      lines[i] = `${indent}root ${absoluteDir};     ${LANDING_ROOT_TAG}`;
      return { text: lines.join('\n'), changed: true };
    }
    for (const ch of stripped) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        // 出块了还没找到 root，就放弃（那不是我们预期的形状）
        if (depth <= 0) return { text, changed: false };
      }
    }
  }
  return { text, changed: false };
}

/** 装机前把导航页的 `root` 改指到稳定目录（幂等；找不到那个 location 就原样返回） */
export function installIntoLandingRoot(options: {
  confPath: string;
  absoluteDir: string;
}): { changed: boolean } {
  const original = fs.readFileSync(options.confPath, 'utf8');
  const { text, changed } = retargetLandingRoot(original, options.absoluteDir);
  if (changed) fs.writeFileSync(options.confPath, text);
  return { changed };
}

/**
 * 把导航页的 `root` 改回 `html`（卸载与失败回滚用）。
 *
 * 卸载要**完整撤销**：只撤 include 而留下一行改过的 `root`，会让宿主配置在下一次
 * `brew upgrade nginx` 后指向一个已经没人维护的 `landing/` 目录（旧导航页永远僵在那里）。
 */
export function uninstallLandingRoot(options: { confPath: string }): { changed: boolean } {
  const original = fs.readFileSync(options.confPath, 'utf8');
  const lines = original.split('\n');
  const index = lines.findIndex((line) => line.includes(LANDING_ROOT_TAG));
  if (index === -1) return { changed: false };
  const indent = /\s*/.exec(lines[index] as string)?.[0] ?? '';
  lines[index] = `${indent}root html;`;
  fs.writeFileSync(options.confPath, lines.join('\n'));
  return { changed: true };
}