/**
 * 宿主机 nginx 反代片段（spec §7、ADR-0003）：本 app 挂在宿主 nginx 的**子路径**上。
 *
 * ## 为什么是「不剥前缀」而不是 ADR-0003 举例的「剥前缀」
 *
 * ADR-0003 说两种写法都兼容（剥 → `BASE_PATH=/`，不剥 → `BASE_PATH=/dinner`），这对**独占**的
 * server block 成立。但在本机真实环境里（`/opt/homebrew/etc/nginx/servers/apps-proxy.conf`，
 * 8080 一个 server block 用 `/apps/xxx/` 前缀区分 pi-web / mdtools / baby / frame / qqmusic），
 * 剥前缀写法是**坏的**：
 *
 *   * `BASE_PATH=/` 时前端会请求根路径的 `/api/*`、`/assets/*`、`/icons/*`（`web/src/config.ts`
 *     与 `static.ts` 的 `<base href="/">`），而 8080 上的 `location /api/` 属于 pi-web——
 *     请求被转给别的 app，表现为「页面能开、数据全挂」。
 *   * 想补救就得额外加 `location /assets/`、`/icons/`、`/api/` 三条——而 `/api/` 已被占用，
 *     补救本身不可能干净（要么撞车、要么得靠 location 优先级去抢）。
 *
 * 不剥前缀则一切自洽：前缀由 app 自己服务（`BASE_PATH=/apps/dinner`，Hono 按其挂载，
 * `<base href="/apps/dinner/">` 让相对资产也解析回前缀内），**只需要一条 location**。
 *
 * ## 为什么不做 SPA fallback
 *
 * 深链（如 `/apps/dinner/slot/2025-06-01:dinner`）不需要 nginx 兜底：app 自己就把
 * 无扩展名的未匹配路径交给 Router（`server/src/app.ts` 的 `looksLikeFile` 分支返回 index.html）。
 * 所以**不要**加 `try_files` 或 `error_page 404 = .../index.html`——后者会把 API 的真 404
 * 也变成 200 HTML，让前端的 `{error:...}` 解析拿到一坨 HTML（实测过：资产 404 被吞成
 * 「404 但 content-type 是 text/html」，排障时极具误导性）。
 *
 * 片段生成成**仓库里的文件**（`deploy/nginx/dinner-location.conf`）而不是只写在文档里：
 * 宿主 nginx 的配置不在版本控制内，一次改动就是不可复现的——将来换机器/重装 nginx 时，
 * 这份文件是唯一能恢复的真相。`pnpm deploy:nginx` 负责把它装进宿主配置。
 */
/** 反代上游地址（app 的监听地址；与 plist 的 PORT 必须一致） */
export function upstream(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * 挂在 `/apps/dinner/` 下、**不剥前缀**的 location 片段。
 *
 * `proxy_set_header` 只给 Host（app 不感知 X-Forwarded-*，无 WebSocket 故不需要 Upgrade）。
 * `proxy_intercept_errors` 刻意**不开**：见文件头「为什么不做 SPA fallback」。
 */
/**
 * 挂到宿主机已有 server block（如 8080 的 `/apps/` 家族）里的 **location 片段**。
 *
 * 这是本仓库实际使用的形态（用户口径：并入 `/apps/` 家族），由 `apps-proxy.conf` 里
 * 一行 `include` 引入（见 `nginx-include.ts`）。所以它**不带** `server { }` 外壳——
 * location 必须落在已有的 server 里。
 *
 * （若将来要挂到 `servers/` 目录下自成一体，那才需要自带 server 外壳：`include servers/*`
 * 在 `http {}` 上下文里，裸 `location` 会报 `"location" directive is not allowed here`。
 * 两种形态的差别只有一个外壳，所以外壳由调用方决定，本函数不猜。）
 *
 * `proxy_set_header` 只给 Host（app 不感知 X-Forwarded-*，无 WebSocket 故不需要 Upgrade）。
 * `proxy_intercept_errors` 刻意**不开**：见文件头「为什么不做 SPA fallback」。
 */
export function renderNginxLocation(options: { port: number; mountPath: string }): string {
  const { port, mountPath } = options;
  const trimmed = mountPath.replace(/\/+$/, '');
  const lines = [
    `# 家餐桌（DinnerOrder）—— 子路径反代（ADR-0003：不剥前缀 → BASE_PATH=${trimmed}）`,
    '# 由 server/src/deploy/nginx.ts 生成，勿手工编辑；重装用 pnpm deploy:install。',
    '#',
    '# 为什么是「不剥前缀」（proxy_pass 不带尾斜杠）：本机 8080 的 server block 用',
    '# /apps/xxx/ 前缀区分多个 app，其中 location /api/ 已属于 pi-web。若剥前缀（BASE_PATH=/），',
    '# 本 app 前端会去请求根路径的 /api/*、/assets/*、/icons/*，要么被转给别的 app，要么得靠',
    '# location 优先级去抢——实测需要额外 4 条 location 才能跑通。不剥前缀时前缀完全由 app',
    '# 自己服务（Hono 按 BASE_PATH 挂载 + <base href> 让相对资产也解析回前缀内），只需一条。',
    `location = ${trimmed} { return 301 ${trimmed}/; }`,
    '',
    `location ${trimmed}/ {`,
    `    proxy_pass ${upstream(port)};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 自带 `server { }` 外壳的完整 server block（供「挂到 `servers/` 目录」那种形态使用）。
 *
 * 仅用于**独立实例自检与实测**：起一个隔离端口的 server 验证片段语义（不碰宿主 8080）。
 * 生产不用它（生产用的是上面那个 location 片段 + include）。
 */
export function renderStandaloneServer(options: {
  port: number;
  mountPath: string;
  listen: string;
}): string {
  const body = renderNginxLocation({ port: options.port, mountPath: options.mountPath })
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n');
  return `server {\n    listen ${options.listen};\n    server_name localhost;\n\n${body}}\n`;
}

/**
 * **剥前缀**写法需要额外补的 location（本仓库**不用**它，但放在这里作为对照）。
 *
 * `BASE_PATH=/` 时前端请求的是**根路径**的 `/api/*`、`/assets/*`、`/icons/*`、
 * `/manifest.webmanifest`（`web/src/config.ts` 的 apiBaseUrl + `static.ts` 的
 * `<base href="/">`），而这些东西的相对位置已经不在 `/dinner/` 下面了，所以必须在
 * nginx 里逐条代理回同一个上游。
 *
 * **`proxy_pass` 一律不带路径（尾部分）。** 实测（本机 nginx，app 跑 `BASE_PATH=/`）：
 *   * `proxy_pass http://127.0.0.1:8787/;` → `/assets/x.js` 被转成 `/x.js` → 上游 404；
 *   * `proxy_pass http://127.0.0.1:8787;`（不带尾斜杠/路径）→ 原样转发 `/assets/x.js` → 200。
 * 差别在 nginx 的规则：`proxy_pass` 带 URI 时它会用那个 URI **替换**匹配到的 location 前缀；
 * 不带 URI 时 URI 原样传递。这些 location 的匹配前缀本来就是需要保留的（/assets/ 就是上游要的
 * 路径），所以必须用不带路径的写法。
 *
 * **本机不可用的真实原因**：其中 `location /api/` 在宿主 8080 上已属于 pi-web
 * （`apps-proxy.conf`），剥前缀写法会抢走它的 API 流量。所以本仓库选「不剥前缀」。
 */
export function strippedPrefixLocations(port: number): string[] {
  return [
    `location /assets/ { proxy_pass ${upstream(port)}; }`,
    `location /icons/ { proxy_pass ${upstream(port)}; }`,
    `location = /manifest.webmanifest { proxy_pass ${upstream(port)}; }`,
    `location /api/ { proxy_pass ${upstream(port)}; }`,
  ];
}

/**
 * 一段**自检**用的完整 nginx 配置：隔离端口 + 与 `include servers/*` 同一上下文的 server block。
 *
 * 它的用途是「不碰宿主 8080 也能证明片段是对的」——实测时用它起一个隔离实例，
 * 断言子路径下的入口/资产/API/深链全通。这样验证是可重复的，也不要求改宿主配置。
 */
export function renderProbeServer(options: {
  port: number;
  mountPath: string;
  listen?: string;
}): string {
  return `# 自检用 server block（独立端口，与宿主 8080 无关）\n${renderStandaloneServer({
    ...options,
    listen: options.listen ?? '127.0.0.1:18080',
  })}`;
}
