# 部署与运维（M1-13 · spec §7 · S10）

家里 Mac mini 上常驻可用，两条访问通道都要能用，数据每天热备。本文是**操作手册**；
真正的动作都在 `deploy:*` 脚本里（可重复执行、可卸载），本文只讲怎么用与排障。

> 权威依据：`docs/spec/implementation-spec.md` §7、ADR-0003。本文记录的**实测记录**是 2026-09-20
> 在本机 `chenMac-mini.local` 上跑出来的真实结果，不是「应该能行」。

## 一条命令装好

```bash
pnpm build          # 生产跑的是 server/dist 与 web/dist，装机前必须有产物
pnpm deploy:install # 装 launchd 三个 agent + nginx 片段 + .env 权限 + 备份排除
pnpm deploy:status  # 只读巡检：现在装成什么样
```

先看要做什么再动手（不改系统）：

```bash
pnpm deploy:install --dry-run
```

卸载（**不删数据**：数据库、热备、`.env` 都留着）：

```bash
pnpm deploy:uninstall
```

## 装了什么

| 组件 | 位置 | 作用 |
| --- | --- | --- |
| 直连服务 | `~/Library/LaunchAgents/com.naoki.dinnerorder.plist` | `8787`、`BASE_PATH=/` —— S10 的「直连 `http://<host>.local:8787`」 |
| 子路径服务 | `~/Library/LaunchAgents/com.naoki.dinnerorder.subpath.plist` | `8786`、`BASE_PATH=/apps/dinner` —— nginx 反代目标 |
| 每日热备 | `~/Library/LaunchAgents/com.naoki.dinnerorder.backup.plist` | 每天 03:00 跑 `sqlite3 .backup` → `backups/dinner-<日期>.db` |
| nginx 片段 | `deploy/nginx/dinner-location.conf`（仓库内，被 include） | `/apps/dinner/` → `127.0.0.1:8786` |
| 导航页 | `/opt/homebrew/etc/nginx/landing/index.html`（装机生成） | 8080 的 `/apps/` 那一页「本地服务统一入口」 |
| 图标 | `web/public/favicon.ico` + `web/public/icons/*` | 页签图标（详见 [`web/scripts/icons/README.md`](../../web/scripts/icons/README.md)） |
| 备份排除清单 | `deploy/tm-exclusions.txt`（**装机生成，不入库**——内容是本机绝对路径） | `.env` 与 `data/logs/` 的排除记录（换机后照它重加） |

### plist 长什么样

plist **不手写、不入库**，而是由 `server/src/deploy/launchd.ts` 生成（`install` 写盘）：
绝对路径随机器而变（仓库位置、node 在哪），写死一份要么在别人机器上跑不起来、要么要人手改三处。
下面是本机生成物的关键部分（与 `launchctl print` 里看到的一致）。

**常驻服务**（`com.naoki.dinnerorder`；子路径实例同 shape，只是 `Label` / `PORT` / `BASE_PATH` / 日志名不同）：

```xml
    <key>Label</key>
    <string>com.naoki.dinnerorder</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/Cellar/node@22/22.22.2/bin/node</string>   <!-- 绝对路径：launchd 不读 PATH -->
        <string>--env-file-if-exists=.env</string>                        <!-- 相对路径：靠 WorkingDirectory 定位 -->
        <string>/Users/chenjingjing/DinnerOrder/server/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/chenjingjing/DinnerOrder</string>                      <!-- 缺省是 /，必须显式给 -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key><string>8787</string>
        <key>HOST</key><string>0.0.0.0</string>
        <key>DB_PATH</key><string>data/dinner.db</string>
        <key>BASE_PATH</key><string>/</string>
    </dict>
    <key>RunAtLoad</key><true/>                                            <!-- 开机（登录）自启 -->
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>                         <!-- 崩溃拉起，正常退出不拉 -->
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key>
    <string>/Users/chenjingjing/DinnerOrder/data/logs/com.naoki.dinnerorder.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/chenjingjing/DinnerOrder/data/logs/com.naoki.dinnerorder.err.log</string>
```

三个 key 的用意（每条都有对应的测试或实测）：

* **`KeepAlive` 用字典型 `{SuccessfulExit: false}`，不是 `true`**：`true` 会在 `SIGTERM` 正常停机后
  立刻把它拉回来（`launchctl kickstart -k` 会抖）。字典型才是「崩了拉起、正常退出就歇着」。
* **`RunAtLoad`**：登录时拉起（launchd 的 LaunchAgent 是登录级，不是 boot 级——Mac mini 本来就要
  自动登录，这也是 spec §7「LaunchAgent + 开机自动登录」的意思）。
* **`EnvironmentVariables` 把端口/库/挂载点钉进 plist**：虽然 `.env` 也读，但在 plist 里再钉一遍
  是为了让「服务挂在哪儿、用哪个库」在 `launchctl print` 里直接看得见（排障时不必去猜 `.env`
  被谁改过）。真实 shell 环境变量优先级高于文件（`config.ts`），所以两处不一致时以 plist 为准。

**每日热备**（与常驻服务分属两个 agent：一个崩了不该牵连另一个）：

```xml
    <key>Label</key>
    <string>com.naoki.dinnerorder.backup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/Cellar/node@22/22.22.2/bin/node</string>
        <string>/Users/chenjingjing/DinnerOrder/server/dist/deploy/backup-cli-entry.js</string>
        <string>--db</string><string>data/dinner.db</string>
        <string>--keep</string><string>7</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
```

**没有 `RunAtLoad`，也没有 `KeepAlive`**：它是每天跑一次的批处理，不是常驻进程。
跑的是**编译产物**（`node dist/deploy/backup-cli-entry.js`）——热备要能在「没装 devDependencies」
的机器上跑得起来（`tsx` 是 devDependency）。

### 为什么要两个服务实例

一个进程只能有一个 `BASE_PATH`，而 S10 要求**两条通道同时可用**：

* 直连 `http://<host>.local:8787` 需要 `BASE_PATH=/`（根路径）；
* nginx 子路径 `/apps/dinner/` 需要 `BASE_PATH=/apps/dinner`（不剥前缀）。

两者不可能由一个进程同时满足。也不能让 nginx 侧走「剥前缀 + `BASE_PATH=/`」：那样本 app 的前端会去请求
根路径的 `/api/*`，而 8080 上那个 location 属于 pi-web（实测需要额外 4 条 location 才能跑通，
还会抢别人的 API 流量）。所以分成两个进程，**共用一个 SQLite 文件**——WAL 支持多进程读写，
写锁竞争由 `db/index.ts` 的 `busy_timeout = 5000` 兜。

取舍的完整理由（含被否决的备选与「若日后要省一个进程」的退路）见
[ADR-0008](../adr/0008-two-instances-per-access-path.md)。

### nginx 为什么只加了一行

`servers/apps-proxy.conf` 是宿主上服务多个 app 的手写配置。装机只往里**插一行 include**
（片段本体留在仓库里、被版本控制）：

```nginx
include /Users/chenjingjing/DinnerOrder/deploy/nginx/dinner-location.conf;     # dinnerorder-location
```

实测 diff 就这两行（一行 include + 一个空行）。片段内容：

```nginx
location = /apps/dinner { return 301 /apps/dinner/; }

location /apps/dinner/ {
    proxy_pass http://127.0.0.1:8786;   # 注意：不带尾斜杠（不剥前缀）
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

**不做 SPA fallback**（没有 `try_files` / `error_page 404`）：深链由 app 自己交给 Router
（`server/src/app.ts` 的 `looksLikeFile` 分支）。加 fallback 会把 API 的真 404 吞成 200 HTML，
前端的 `{error:...}` 解析拿到一坨 HTML——排障时极具误导性。

## 备份与恢复

### 日常

`com.naoki.dinnerorder.backup` 每天 03:00 跑一次：

```bash
pnpm backup                 # 手动跑一次（缺省静默，只在滚动删除时打一行）
pnpm backup -- --json       # 结构化回执
pnpm backup -- --db data/dinner.dev.db --keep 3   # 指定库与保留份数
```

热备文件名带**日期**（`backups/dinner-2026-09-20.db`），所以「按日滚动」是「同一天重复跑只覆盖当天那份」，
不是「每跑一次多一份」。保留份数缺省 7（`--keep` 可改）。滚动**只认这个形状的文件名**——
`backups/` 里别的文件（手工备份、说明）不会被删。

热备用的是 `sqlite3 .backup`，不是 `cp`：库跑在 WAL 模式，最近写入先落 `-wal`，
直接复制 `.db` 会得到一份**缺最新数据却看起来正常**的备份。`.backup` 读得穿 WAL。
备份完会把它设回 `journal_mode = delete`（冷藏快照不需要并发写），这样任何人打开备份都不会在
`backups/` 里留下 `-wal`/`-shm` 侧文件。

### 恢复演练（已实测）

```bash
# 1. 停服务（两条通道一起停，避免恢复过程中有人写入）
launchctl bootout gui/$(id -u)/com.naoki.dinnerorder
launchctl bootout gui/$(id -u)/com.naoki.dinnerorder.subpath

# 2. 备份坏库（不删，留着排查）再把热备复制过去
mv data/dinner.db data/dinner.db.broken
sqlite3 backups/dinner-<日期>.db ".backup 'data/dinner.db'"
#    或直接 cp（热备文件本身已是完整一致快照）： cp backups/dinner-<日期>.db data/dinner.db

# 3. 校验
sqlite3 data/dinner.db "PRAGMA integrity_check;"    # 期望 ok
sqlite3 data/dinner.db "SELECT group_concat(version, ',') FROM schema_migrations ORDER BY version;"  # 期望 001..012

# 4. 起服务
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.naoki.dinnerorder.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.naoki.dinnerorder.subpath.plist
curl -s http://127.0.0.1:8787/api/health
```

**实测结果（2026-09-20）**：从 `backups/dinner-2026-09-20.db` 还原后 32 张表、迁移版本
`001..012` 齐全、种子家人（妈妈/爸爸/大宝/小宝）可读、`integrity_check` 返回 `ok`。

### 密钥不进备份（双通道）

`.env`（chmod 600）与 `data/logs/`（`DEBUG=1` 时的完整请求/响应）已被排除出两条备份通道：

```bash
tmutil isexcluded .env data/logs      # 期望两条都 [Excluded]
cat deploy/tm-exclusions.txt          # 排除清单（换机后照它重加）
```

热备那一侧是「本来就不含」——它只备数据库文件。实测：备份文件里搜不到任何 key 字样。

系统重装/换机后 Time Machine 排除会丢，按清单重加：

```bash
while read -r line; do case "$line" in /[!/]*) tmutil addexclusion "$line";; esac; done < deploy/tm-exclusions.txt
```

## 8080 导航页（「本地服务统一入口」）

`location = /apps/` 那一页是这台机器上**所有**服务的入口。它原先只活在
`/opt/homebrew/Cellar/nginx/<版本>/html/index.html`，而**那个目录名带 nginx 版本号**——
`brew upgrade nginx` 之后我们对它的改动会静默消失（新版若没带 `html/`，连页面都 404）。
所以现在：**生成器与产物都在仓库里，装机时重新写一遍**。

装机做两件事（缺一不可）：

1. 把那个 location 的 `root html`（相对 nginx 的 **prefix** 解析，于是落在版本目录里）
   改指到稳定的 `/opt/homebrew/etc/nginx/landing`，并留一个带 `#` 的标记（幂等）；
2. 把生成的导航页写到那里。

**卸载会两件都撤**（`root` 还原成 `html`、`include` 删掉），实测宿主配置能逐字节回到改动前。

### 排版

按**用途分组**（家庭日常 / 设备与媒体 / 工具与开发），一行一条、图标居左、
端口做右侧等宽小标签、长名字 ellipsis 截断。8 条平铺时找东西靠逐条扫，分组后是找标题——
手机上尤其明显。端口的处理是刻意的：它是排查「服务到底跑没跑」的第一手线索，
但平时不该抢注意力，所以留在一行里但缩成小标签（原先那版把 `/apps/pi/ → 30141` 全写进副标题）。

### 图标（两层，都要）

> 完整的图标规则见 [`web/scripts/icons/README.md`](../../web/scripts/icons/README.md)。

**家餐桌自己的页签图标**（`web/public/`）：`favicon.ico` 在 **public 根**（不能放 `icons/`——
浏览器未声明时会去要 origin 根的 `/favicon.ico` 这**一个**固定路径），
`index.html` 里显式声明每档（不声明时经 nginx 访问会拿到 **pi-web 的图标**，实测过），
真源是 `icons/icon.svg`，生成用 `pnpm --filter @dinnerorder/web run icons`。

**导航页自己的页签图标**（`landing.ts` 内嵌）：四格「应用启动台」，页面链接蓝。
它**必须是 data URI，不能是相对路径的文件**——`/apps/` 下有
`location /apps/ { return 404 … }` 的兜底，`/apps/icon.svg` 这种请求会直接被 404（实测过）。
条目图标同理内嵌：导航页的作用恰恰是「某个 app 挂了也能从这里进」，
让它去引用那个 app 自己的静态资源就本末倒置了。

导航页顶部那张图与页签用的是**同一份** SVG。

## 两种 nginx 写法（AC2 都实测过）

ADR-0003 说剥不剥前缀都兼容。两种写法都实测通过，但**本仓库只能用不剥前缀**——
原因不在兼容性，而在宿主 8080 上那块地被别人占了。

### ① 不剥前缀（本仓库采用）

```nginx
location = /apps/dinner { return 301 /apps/dinner/; }

location /apps/dinner/ {
    proxy_pass http://127.0.0.1:8786;   # 不带尾斜杠 = 不剥前缀
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

对应 app 跑 `BASE_PATH=/apps/dinner`。**一条 location 就够**：前缀由 app 自己服务
（Hono 按 `BASE_PATH` 挂载 + `<base href>` 让相对资产解析回前缀内）。

实测（2026-09-20，`chenMac-mini.local:8080`）：入口 200、`/api/health` 200、
`assets/*.js` 200 `text/javascript`、深链 200 `text/html`、manifest 200。

### ② 剥前缀（本机不可用，但仍记录写法与实测）

```nginx
location = /dinner { return 301 /dinner/; }
location /dinner/ { proxy_pass http://127.0.0.1:8787/; ... }   # 带尾斜杠 = 剥前缀

# 以下 4 条是**必须**的额外补丁：BASE_PATH=/ 时前端会去请求根路径的它们
location /assets/  { proxy_pass http://127.0.0.1:8787; }
location /icons/   { proxy_pass http://127.0.0.1:8787; }
location = /manifest.webmanifest { proxy_pass http://127.0.0.1:8787; }
location /api/     { proxy_pass http://127.0.0.1:8787; }
```

对应 app 跑 `BASE_PATH=/`（就是那个直连实例）。实测（17991 端口隔离实例）：
入口 200、`/api/health` 200、`/assets/*.js` 200 `text/javascript`、`/icons/icon-192.png` 200
`image/png`、manifest 200、深链 200。

**两个坑（都实测踩过）**：

1. **`proxy_pass` 在这些 location 上必须不带路径**。写 `proxy_pass http://127.0.0.1:8787/`
   会把 `/assets/x.js` 转成 `/x.js`（上游 404）。差别在 nginx 的规则：`proxy_pass` 带 URI 时
   它用那个 URI **替换**匹配到的 location 前缀；不带则原样传递。这些 location 的匹配前缀本来
   就是要保留的路径，所以必须不带路径。
2. **`location /api/` 会与其他 app 抢流量**——本机 8080 上它已属于 pi-web。这正是本仓库
   不用这个写法的**唯一**原因（不是兼容性问题）。

对照代码：`server/src/deploy/nginx.ts` 的 `strippedPrefixLocations()`（那 4 条补丁的生成器，
带上述理由的注释），由 `nginx.test.ts` 钉住写法。

## 排障

```bash
pnpm deploy:status                                    # 一眼看装成什么样
launchctl print gui/$(id -u)/com.naoki.dinnerorder    # 单个 agent 的详情（state / pid / runs）
tail -20 data/logs/com.naoki.dinnerorder.err.log      # 直连实例的 stderr
tail -20 data/logs/com.naoki.dinnerorder.subpath.err.log  # 子路径实例的 stderr
tail -20 data/logs/com.naoki.dinnerorder.backup.err.log   # 热备的 stderr（失败才有内容）
nginx -t && nginx -s reload                           # 改过 nginx 配置后
```

常见症状：

| 症状 | 原因与处理 |
| --- | --- |
| 直连 8787 返回 `{"error":"not_found","hint":"本服务挂载在 /apps/dinner/…"}` | 访问 `http://<host>:8787/apps/dinner/`；8787 是根路径实例，别带前缀 |
| nginx 侧 404 | `nginx -t` 看 include 是否还在；`launchctl list \| grep dinner` 看 8786 实例活没活 |
| 服务不自动起 | `launchctl print` 看 `state`；plist 里 `RunAtLoad` 是否还在 |
| 崩溃后没拉起 | `KeepAlive` 必须是 `{SuccessfulExit: false}` 字典型；写成 `true` 会在正常停机后也拉起 |
| 热备没产出 | `tail data/logs/com.naoki.dinnerorder.backup.err.log`；手动 `pnpm backup` 看报错 |
| 页签里是**别的 app** 的图标 | `index.html` 的 `<link rel="icon">` 丢了；或 `web/public/favicon.ico` 不在（浏览器会退到 origin 根那份，而那属于 pi-web） |
| 导航页 404 或回到旧样子 | `brew upgrade nginx` 后 `root` 指回了版本目录；重跑 `pnpm deploy:install` |
| 导航页图标不显示 | 它的图标是 data URI 内嵌的，坏了通常是 `deploy:install` 没重跑（页面的 HTML 在 `landing/` 下，不在版本目录里） |
| 备份目录堆满 `-wal`/`-shm` | 不该发生（备份后已复位 `journal_mode`）；若见到，说明有别的工具在打开那些备份 |

**两个实例共用一个库**：如果日志里出现 `SQLITE_BUSY`，那是写锁竞争超了 5 秒——
家里多人同时在手机上定餐才可能触发，届时把 `busy_timeout` 调大即可（`db/index.ts`）。

## 实测记录（2026-09-20，chenMac-mini.local）

| AC | 验证方式 | 结果 |
| --- | --- | --- |
| launchd 开机自启 | `bootout` + `bootstrap` 后不 kickstart，检查端口已在监听 | ✅ 8786 自动起来 |
| 崩溃自动拉起 | `kill -9` 直连实例，观察 pid 变化 | ✅ `78432 → 78589`，端口恢复 |
| 正常退出不拉起 | `kill -TERM` 子路径实例，等 8 秒 | ✅ 保持停止（`SuccessfulExit: false` 的语义） |
| 每日热备定时 | `launchctl kickstart …backup`，检查 `backups/` 产出 | ✅ `dinner-2026-09-20.db`（475 KB） |
| 热备恢复演练 | 从热备还原 → `integrity_check` + 迁移版本 + 种子数据 | ✅ 32 表 / `001..012` / `ok` |
| 通道① 直连 | `curl http://chenMac-mini.local:8787/` 与 `/api/health` | ✅ 200，`basePath: "/"` |
| 通道② nginx 子路径（不剥前缀） | `curl http://chenMac-mini.local:8080/apps/dinner/` 与 `/api/health` | ✅ 200，`basePath: "/apps/dinner"` |
| 剥前缀写法（对照实验，隔离端口 17991） | 入口 / API / manifest / assets / icons / 深链 逐条 curl | ✅ 全 200（6/6），见上文「两种 nginx 写法」 |
| 深链两条通道 | `/slot/2025-06-01:dinner` | ✅ 双双 200 text/html |
| 子路径静态资产 | 按 `<base href>` 解析出的 `assets/*.js` | ✅ 200 `text/javascript` |
| 双实例共用一库 | 两个进程都打开 `data/dinner.db`，各自 `/api/health` 正常 | ✅ 见「为什么要两个服务实例」 |
| `.env` 权限 | `stat -f %Sp .env` | ✅ `-rw-------` |
| 排除双通道 | `tmutil isexcluded` + 备份文件里搜 key 字样 | ✅ 均 `[Excluded]`，搜不到 |
| **页签图标（两条通道）** | 逐档下载并解码：`favicon.ico`(48/32/16) + `icon-16/32/180/192/512` + maskable | ✅ 全 200 且尺寸正确 |
| **图标与 pi-web 不同** | 32px 下与 pi-web 图标逐像素比 | ✅ 差异 95% 的像素 |
| **导航页两处改动** | `diff` 宿主配置：只有 `root` 那一行 + include 那一行 | ✅ 就这两处 |
| **导航页装卸还原** | 装 → 卸 → `diff` 与最初备份 | ✅ 逐字节一致 |
| 导航页在手机上可读 | 390×844 视口截图 | ✅ 分组卡片、无横向溢出 |

## 相关文件

```
server/src/deploy/
  paths.ts           路径与命名约定（热备文件名、launchd label）
  launchd.ts         两个 plist 的生成（含 KeepAlive / RunAtLoad 的理由）
  backup.ts          热备核心（.backup + 按日滚动 + 侧文件清理）
  backup-cli.ts      热备 CLI 逻辑（参数与家庭时区日期）
  backup-cli-entry.ts  热备生产入口（node dist/…，不依赖 tsx）
  nginx.ts           location 片段生成（两种写法与为何选不剥前缀）
  nginx-include.ts   往宿主已有 server block 插/撤 include（大括号配平）＋ 导航页 root 重定向
  landing.ts         8080 导航页的生成（分组排版、条目图标内嵌、页签图标）
  secrets.ts         .env 权限、Time Machine 排除、排除清单
  install.ts         装机/卸载编排（launchctl / nginx -t / tmutil / 导航页）
  deploy-cli.ts      `pnpm deploy:*` 的入口
deploy/nginx/dinner-location.conf   片段本体（被宿主 include）
deploy/tm-exclusions.txt            排除清单（装机生成，已 gitignore）
web/public/favicon.ico              页签图标（ico，必须在 public 根）
web/public/icons/icon.svg           图标真源（改设计只改它）
web/scripts/icons/                  图标生成脚本与说明（**不放 public/**：那是给人看的）
```
