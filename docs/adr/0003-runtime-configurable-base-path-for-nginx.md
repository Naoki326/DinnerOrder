# 挂载路径运行时可配：兼容宿主机既有 nginx 反代

用户的常开主机上已有 nginx 跑着其他服务，本 app 不独占根路径，可能挂在子路径（如 `/dinner/`）、独立端口或未来任意位置。决定**路径无关化**：前端资产全部相对引用（Vite `base: './'`）；服务端启动读 `BASE_PATH` 环境变量（默认 `/`），Hono 按其挂载 API 与静态资源，并把实际路径注入页面（`window.__APP_CONFIG__.basePath`）——前端 Router `basename`、API 前缀、PWA manifest 的 `start_url`/`scope` 均从注入值推导。效果：同一构建产物在 `/`、`/dinner/`、任意端口/主机名下都能跑，无需重打包；nginx 端剥不剥前缀都兼容（剥 → `BASE_PATH=/`，不剥 → `BASE_PATH=/dinner`），HTTPS 与门禁跟随宿主 nginx，app 不感知；无 WebSocket，无需 upgrade 配置。副效果：直连 `http://<host>.local:8787` 永远可用作 nginx 故障时的兜底（票 #4 的访问方式因此细化为「nginx 导航 + 直连兜底」）。

被否决的备选：构建期固定 base 路径（换挂载点就要重打包，家人侧不可运维）；假定独占根路径（与既有服务冲突）；子域名方案（依赖家里 DNS/mDNS 配置，超出 app 可控范围）。
