# 双实例部署：一个进程一条路径，两条访问通道各一个

生产部署跑**两个同构的 Node 进程**，共用同一个 SQLite 文件：

* `com.naoki.dinnerorder` —— `8787`、`BASE_PATH=/`，用于**直连兜底** `http://<主机名>.local:8787`；
* `com.naoki.dinnerorder.subpath` —— `8786`、`BASE_PATH=/apps/dinner`，作为**宿主 nginx 子路径**反代的上游。

两者是同一份 `server/dist/index.js`，只有 `PORT` / `BASE_PATH` 不同（由各自的 plist 注入）。

## 理由

`BASE_PATH` 是**启动配置**（ADR-0003 的运行时注入），一个进程只能有一个值，而 §1.2 的 S10 要求
**两条通道同时可用**。两条通道对 `BASE_PATH` 的要求是冲突的：

* 直连要根路径（`BASE_PATH=/`），否则 `http://<host>.local:8787/` 是 404 —— 而兜底通道的价值
  恰恰在于「nginx 挂了也能进」，让家人记住一个带前缀的兜底地址等于把兜底也变复杂了；
* nginx 子路径要不剥前缀（`BASE_PATH=/apps/dinner`）。

「剥前缀 + `BASE_PATH=/`」这条路在**本机宿主上不可用**（不是不兼容）：宿主 8080 那个 server block
用 `/apps/xxx/` 前缀区分多个 app，而 `location /api/` 已属于 pi-web。`BASE_PATH=/` 时本 app 的前端
会去请求**根路径**的 `/api/*`、`/assets/*`、`/icons/*`，于是要么被转给别的 app、要么得跟 pi-web
抢同一个 location。实测（2026-09-20）：剥前缀写法需要额外补 4 条 location 才能自己跑通
（`/assets/`、`/icons/`、`/manifest.webmanifest`、`/api/`，且 `proxy_pass` 必须不带路径，
否则前缀被替换掉），其中 `/api/` 那条会抢走 pi-web 的流量——所以在多 app 共存的宿主上它不可用。

## 代价与兑付

* **两个进程共用一个 SQLite 文件**：WAL 模式支持多进程读写，写锁竞争由
  `server/src/db/index.ts` 的 `busy_timeout = 5000` 兜底。家里的写入频率（几个人点餐、
  偶尔改菜单）远低于这个量级；真出现 `SQLITE_BUSY` 时把超时调大即可。
* **两个进程的内存状态不共享**：本 app 的推荐会话、换菜会话都活在**客户端**（`SlotView` 的组件状态），
  服务端没有会话态；唯一的内存态是 LLM 客户端与 SQLite 连接，两者都不需要在实例间一致。
* **日志分文件**：`data/logs/<label>.out.log`，否则两条启动行混在一个文件里，排障时分不清谁是谁。

## 被否决的备选

* **单实例 + 直连也带前缀**（`http://<host>.local:8787/apps/dinner/`）：可行且更简单，但把兜底地址
  变成带前缀的形态，偏离 S10 原文「直连 `http://<host>.local:8787`」。**若日后要省一个进程，
  这是代价最小的退路**（改 plist 的 `BASE_PATH` + 文档即可，无需改代码）。
* **单实例 + 剥前缀 + 补 4 条 location**：在多 app 共存的宿主上会与邻居抢 `location /api/`，不可用。
* **两个进程用两个库再同步**：数据分叉，彻底不可接受。

## 与既有 ADR 的关系

* **ADR-0002（单进程前后端一体）不被推翻**：每个实例仍是「一个 Node 进程同时服务 API 与 `web/dist`」。
  变的只是「部署几个实例」，而 ADR-0002 论证的是「前后端不拆成两个服务」。
* **ADR-0003（BASE_PATH 运行时注入）被强化**：正因为路径是运行时注入的，同一份构建产物才能
  同时挂 `/` 与 `/apps/dinner` —— 双实例不需要第二份构建产物，这正是 ADR-0003 想要的效果。
  本 ADR 补充的事实是：那个注入值**不能在一个进程里同时取两个值**，所以「两种访问方式并存」
  在部署层表现为两个进程。
