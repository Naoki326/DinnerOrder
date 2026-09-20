/**
 * 安装 / 卸载编排（AC：launchd 开机自启与崩溃拉起、nginx 片段、每日热备、`.env` 权限、排除项）。
 *
 * ## 为什么有卸载
 *
 * 它落进了**真实系统**（`~/Library/LaunchAgents/`、宿主 nginx 配置、Time Machine 排除项）。
 * 没有卸载路径的安装脚本是不可接受的：改了宿主 nginx 又没法干净退出，等于「请神容易送神难」。
 * `uninstall` 逐项撤销（含删掉写进宿主 nginx 的片段文件），并**保留**数据与热备
 * （卸载服务不该顺手删掉家里的餐史与备份，那是数据不是服务）。
 *
 * ## 每一步都可空跑（dry-run 先打印要做什么）
 *
 * 装机动作会改宿主的 nginx 与 launchd 状态，而失败点常常是路径写错（node 在哪、仓库在哪）。
 * 所以 `install` 先跑一遍 `plan()`，把每一步的「目标路径 + 当前状态」全部打出来，
 * 再执行——出问题时人第一眼看到的是「它打算做什么」。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupsDir, logsDir } from './paths.js';
import { BACKUP_LABEL, SERVER_LABEL, SUBPATH_LABEL, buildBackupPlist, buildServerPlist, type PlistOptions } from './launchd.js';
import { renderNginxLocation } from './nginx.js';
import {
  DEFAULT_NGINX_LISTEN_PORT,
  installIntoExistingServer,
  installIntoLandingRoot,
  repoFragmentPath,
  uninstallFromExistingServer,
  uninstallLandingRoot,
} from './nginx-include.js';
import { defaultLandingEntries, landingDir, landingIndexPath, renderLandingPage, svgDataUri } from './landing.js';
import { readFileSync } from 'node:fs';
import {
  ensureEnvMode,
  excludeFromTimeMachine,
  isTimeMachineExcluded,
  renderExclusionsFile,
  secretPaths,
} from './secrets.js';

/**
 * 装机计划：描述「装到哪儿、装成什么样」。
 *
 * 与 `launchd.ts` 的 `PlistOptions` 是同一批字段（plist 就是按这些值生成的），
 * 所以直接用类型别名——两处各写一遍字段时，改一处忘一处会让 plist 与文档/巡检的口径漂移。
 */
export type InstallPlan = PlistOptions;

export interface Step {
  /** 人读的动作名 */
  action: string;
  /** 会被写入/影响的绝对路径 */
  target: string;
  /** 当前状态的人话描述 */
  state: string;
}

/** nginx 的 `servers/*` 目录（Homebrew 装在 /opt/homebrew 时）；找不到就返回 undefined */
export function nginxServersDir(): string | undefined {
  for (const candidate of ['/opt/homebrew/etc/nginx/servers', '/usr/local/etc/nginx/servers']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 宿主机那个「统一入口」配置文件的路径（用户口径：并入已有 8080 的 /apps/ 家族）。
 *
 * 默认取 `servers/apps-proxy.conf`（本机的统一入口，`listen 8080` 所在文件），
 * 可用 `NGINX_CONF` 覆盖——其他机器上那个文件叫别的名字是常态，硬编码一个名字会让脚本只在
 * 这台机器上能用。
 */
export function nginxEntryConfPath(): string | undefined {
  const override = process.env.NGINX_CONF?.trim();
  if (override) return override;
  const serversDir = nginxServersDir();
  if (serversDir === undefined) return undefined;
  const candidate = path.join(serversDir, 'apps-proxy.conf');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/**
 * 宿主 nginx 的监听端口（本机 8080）——**不是** app 的监听端口（8787）。
 *
 * 两者是不同的事：nginx 在 8080 上收外部请求，再把 `/apps/dinner/` 转给 127.0.0.1:8787。
 * 插 include 要按 nginx 的端口定位那个 server block（`findServerBlockEnd` 的入参）。
 */
export function nginxListenPort(): number {
  const override = process.env.NGINX_LISTEN?.trim();
  if (!override) return DEFAULT_NGINX_LISTEN_PORT;
  const parsed = Number.parseInt(override, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`NGINX_LISTEN 必须是 1-65535 的整数，收到：${JSON.stringify(override)}`);
  }
  return parsed;
}

export function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

/** 跑 `launchctl` 并返回退出码（`bootstrap` 已装载会非零，属正常分支，不抛） */
function launchctl(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

/**
 * 导航页的安装（两步，缺一不可）：
 *
 * 1. 把 `location = /apps/` 的 `root` 从 nginx 的**版本目录**改到 `<配置目录>/landing`；
 * 2. 把生成的导航页 HTML 写到那里。
 *
 * 只写文件而不改 `root` 是无效的（请求仍会去版本目录找）；只改 `root` 而不写文件则会 404。
 * 两者都幂等，可以反复跑。
 *
 * **图标从 app 自己的 `icon.svg` 现场读**（而不是在这里再描一份）：两份图标必然漂移，
 * 而导航页上的条目图标正是「是不是这个 app」的第一眼线索。读不到就拿不到图标——
 * 导航页照常生成（只是那条没图标），不让一个图标文件把整次装机弄挂。
 */
export function installLandingPage(options: {
  root: string;
  mountPath: string;
  subPathPort: number;
  listenPort?: number;
}): { indexPath: string; rootChanged: boolean; iconEmbedded: boolean } {
  const confsDir = nginxConfDir();
  if (confsDir === undefined) throw new Error('找不到 nginx 配置目录，无法安装导航页');
  const confPath = nginxEntryConfPath();
  if (confPath === undefined) throw new Error('找不到宿主 nginx 统一入口配置，无法安装导航页');

  const dir = landingDir(confsDir);
  fs.mkdirSync(dir, { recursive: true });

  // 直连实例的图标（web/public 下的真源，与页面眉签用的是同一份：保持一致）
  const svgPath = path.join(options.root, 'web', 'public', 'icons', 'icon.svg');
  const svg = fs.existsSync(svgPath) ? readFileSync(svgPath, 'utf8') : undefined;

  const html = renderLandingPage({
    entries: defaultLandingEntries({
      mountPath: options.mountPath,
      subPathPort: options.subPathPort,
      appIcon: svg === undefined ? '' : svgDataUri(svg),
    }),
    listenPort: options.listenPort ?? nginxListenPort(),
  });

  const indexPath = landingIndexPath(confsDir);
  fs.writeFileSync(indexPath, html);
  const { changed } = installIntoLandingRoot({ confPath, absoluteDir: dir });

  return { indexPath, rootChanged: changed, iconEmbedded: svg !== undefined };
}

/** nginx 的**配置目录**（`nginx.conf` 所在的那层）；找不到返回 undefined */
export function nginxConfDir(): string | undefined {
  const override = process.env.NGINX_CONF_DIR?.trim();
  if (override) return override;
  const serversDir = nginxServersDir();
  return serversDir === undefined ? undefined : path.dirname(serversDir);
}

/** 这个 Label 现在装载着吗（`launchctl print` 的成功与否就是答案） */
export function isServiceLoaded(label: string): boolean {
  return launchctl(['print', `gui/${process.getuid?.() ?? 0}/${label}`]).status === 0;
}

/**
 * 阻塞一段时间（同步）。仅用于装机时的 CLI，不进入任何请求路径。
 *
 * 用 `Atomics.wait` 而不是忙等 `while (Date.now() < until) {}`：后者会把一个核烧满十秒，
 * 而这里等的是**外部进程**（launchd）的异步退场——我们等它就不该霸占 CPU
 * （同类毛病在本票的测试里真出现过：忙等饿死了 sqlite 子进程，详见 `backup.test.ts`）。
 */
function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/**
 * 等 label 真的从 launchd 里消失（最多 `timeoutMs`）。
 *
 * `bootout` 是**异步**的：它返回 0 只代表命令收到了，服务可能还在退。紧接着 `bootstrap`
 * 会报 `Bootstrap failed: 5: Input/output error`——而这句话完全指不到真因（看起来像权限问题），
 * 实测踩过。所以这里轮询到 `print` 真的失败为止。
 *
 * 有界：超时后仍然尝试 bootstrap（宁可让它报自己的错，也不要无限等）。
 */
function waitUntilUnloaded(label: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isServiceLoaded(label)) return;
    sleepSync(100);
  }
}

/**
 * 把 plist 装进 `~/Library/LaunchAgents/` 并 bootstrap。
 *
 * 先 `bootout` 再 `bootstrap`：重复安装（改了 PORT/库路径后重跑）必须是幂等的，
 * 而 `bootstrap` 在一个已装载的 Label 上会报 `Bootstrap failed: 5: Input/output error`——
 * 那种错误信息完全指不到真因。`bootout` 失败（本来就没装）是正常分支，忽略。
 */
export function loadAgent(label: string, plistContent: string): { plistPath: string; reloaded: boolean } {
  const dir = launchAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const plistPath = path.join(dir, `${label}.plist`);

  const alreadyLoaded = isServiceLoaded(label);
  if (alreadyLoaded) {
    launchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${label}`]);
    // 等退净再 bootstrap：bootout 是异步的，不等会得到
    // 「Bootstrap failed: 5: Input/output error」这种指不到真因的错（实测踩过）
    waitUntilUnloaded(label);
  }
  fs.writeFileSync(plistPath, plistContent);
  const bootstrapped = launchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, plistPath]);
  if (bootstrapped.status !== 0) {
    throw new Error(`launchctl bootstrap 失败（${label}）：${bootstrapped.output.trim() || '无输出'}`);
  }
  return { plistPath, reloaded: alreadyLoaded };
}

/** 卸载一个 LaunchAgent：bootout + 删 plist（幂等：没装也不报错） */
export function unloadAgent(label: string): { plistPath: string; removedPlist: boolean } {
  const uid = process.getuid?.() ?? 0;
  launchctl(['bootout', `gui/${uid}/${label}`]);
  const plistPath = path.join(launchAgentsDir(), `${label}.plist`);
  const existed = fs.existsSync(plistPath);
  fs.rmSync(plistPath, { force: true });
  return { plistPath, removedPlist: existed };
}

/**
 * 把 nginx 片段装进宿主配置（用户口径：并入已有 8080 的 `/apps/` 家族）。
 *
 * 做法是「片段文件留在仓库 + 往宿主的统一入口配置文件里插一行 include」：
 * 片段本身被版本控制，而宿主那份手写文件只多一行（下次人工编辑时不会被误删，卸载也只撤这一行）。
 */
export function installNginxFragment(options: {
  serversDir: string;
  fragment: string;
  root: string;
  listenPort: number;
}): string {
  const confPath = nginxEntryConfPath();
  if (confPath === undefined) {
    throw new Error(
      `找不到宿主 nginx 的统一入口配置文件（缺 ${path.join(options.serversDir, 'apps-proxy.conf')}）；` +
        '可用 NGINX_CONF 环境变量指定',
    );
  }
  const fragmentPath = repoFragmentPath(options.root);
  fs.mkdirSync(path.dirname(fragmentPath), { recursive: true });
  installIntoExistingServer({
    confPath,
    fragmentPath,
    fragment: options.fragment,
    listenPort: options.listenPort,
  });
  return confPath;
}

export function uninstallNginxFragment(): { confPath?: string; includeRemoved: boolean } {
  const confPath = nginxEntryConfPath();
  if (confPath === undefined) return { includeRemoved: false };
  const { includeRemoved } = uninstallFromExistingServer({ confPath });
  return { confPath, includeRemoved };
}

/**
 * 找一个可用的 nginx 可执行文件。
 *
 * 默认值不写死路径：本机是 Homebrew 的 `/opt/homebrew/bin/nginx`，但 Intel Mac / Linux 上
 * 位置不同（`/usr/local/bin`、`/usr/sbin`）。找不到就返回 undefined，由调用方决定怎么办
 * （装机时先把配置写好再报错，比一个「文件不存在」的 exec 错好得多）。
 */
export function findNginxBinary(): string | undefined {
  const override = process.env.NGINX_BIN?.trim();
  if (override) return override;
  for (const candidate of ['/opt/homebrew/bin/nginx', '/usr/local/bin/nginx', '/usr/sbin/nginx']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `nginx -t` 是否通过（改动宿主配置后必须先验，再 reload） */
export function nginxConfigOk(nginxBin = findNginxBinary()): { ok: boolean; message: string } {
  if (nginxBin === undefined) {
    return { ok: false, message: '找不到 nginx 可执行文件（可用 NGINX_BIN 指定）' };
  }
  try {
    const output = execFileSync(nginxBin, ['-t'], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    return { ok: true, message: output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    // nginx -t 把结果写 stderr
    return { ok: false, message: `${failure.stderr ?? ''}${failure.stdout ?? ''}` };
  }
}

/** reload 宿主 nginx（无 downtime；配置没改成功时前面已经拦住） */
export function nginxReload(nginxBin = findNginxBinary()): void {
  if (nginxBin === undefined) throw new Error('找不到 nginx 可执行文件（可用 NGINX_BIN 指定）');
  execFileSync(nginxBin, ['-s', 'reload'], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
}

/**
 * 装机计划：把「要做哪几步、每步的目标路径、当前状态」列出来（dry-run 打印它）。
 *
 * 每一步的 `state` 都是**现查**的（文件在不在、服务装载没有），不是猜的：
 * 重装时人最想知道的是「哪些已经就位、哪些会变」。
 */
export function installSteps(plan: InstallPlan): Step[] {
  const plistDir = launchAgentsDir();
  const steps: Step[] = [
    {
      action: `装载直连服务 ${SERVER_LABEL}（开机自启 + 崩溃拉起，BASE_PATH=/）`,
      target: path.join(plistDir, `${SERVER_LABEL}.plist`),
      state: isServiceLoaded(SERVER_LABEL) ? '已装载，将先 bootout 再 bootstrap' : '未装载',
    },
    {
      action: `装载子路径服务 ${SUBPATH_LABEL}（BASE_PATH=${plan.mountPath}，作 nginx 反代目标）`,
      target: path.join(plistDir, `${SUBPATH_LABEL}.plist`),
      state: isServiceLoaded(SUBPATH_LABEL) ? '已装载，将先 bootout 再 bootstrap' : '未装载',
    },
    {
      action: `装载每日热备 ${BACKUP_LABEL}（每天 03:00）`,
      target: path.join(plistDir, `${BACKUP_LABEL}.plist`),
      state: isServiceLoaded(BACKUP_LABEL) ? '已装载，将先 bootout 再 bootstrap' : '未装载',
    },
    {
      action: `写入 nginx 片段并接进 ${nginxListenPort()} 端口的 /apps/ 家族（挂载 ${plan.mountPath}/ → 127.0.0.1:${plan.subPathPort}）`,
      target: nginxEntryConfPath() ?? '（找不到 apps-proxy.conf；可用 NGINX_CONF 指定）',
      state:
        nginxEntryConfPath() === undefined
          ? '跳过：未找到宿主统一入口配置'
          : `将插一行 include（指向 ${repoFragmentPath(plan.root)}）并 reload`,
    },
    {
      action: `恢复 8080 导航页（加一条家餐桌入口）并把它的 root 改到稳定目录`,
      target: nginxConfDir() === undefined ? '（找不到 nginx 配置目录）' : landingIndexPath(nginxConfDir() as string),
      state:
        nginxConfDir() === undefined
          ? '跳过：未找到 nginx 配置目录'
          : fs.existsSync(landingIndexPath(nginxConfDir() as string))
            ? '将覆盖写入（幂等：只加/更新家餐桌那一条，其余条目保留）'
            : '将新建（宿主原先那一份在 Cellar 版本目录里，nginx 升级会丢）',
    },
    {
      action: '校正 .env 权限为 600',
      target: path.join(plan.root, '.env'),
      state: fs.existsSync(path.join(plan.root, '.env')) ? '存在' : '不存在（跳过；没配 key 是合法形态）',
    },
    {
      action: '把 .env 与 data/logs 排除出 Time Machine',
      // 目标给绝对路径：装机时第一眼要看的正是「它往哪个具体路径动手」
      target: secretPaths(plan.root)
        .map((entry) => entry.absolute)
        .join('\n              '),
      state: '逐条 addexclusion（已排除的跳过）',
    },
    {
      action: '准备运行目录（热备目录、日志目录）',
      target: `${backupsDir(plan.root)} + ${logsDir(plan.root)}`,
      state: '幂等创建',
    },
  ];
  return steps;
}

export interface InstallReport {
  steps: Step[];
  agents: { label: string; plistPath: string; reloaded: boolean }[];
  nginx?: { target: string; reloaded: boolean };
  envMode?: { changed: boolean; mode?: number };
  timeMachine: { path: string; excluded: boolean }[];
  exclusionsFile: string;
}

/**
 * 真正装机。`dryRun` 时只返回计划（`steps`），不碰任何文件与系统状态。
 */
export function install(plan: InstallPlan, options: { dryRun?: boolean; nginxBin?: string } = {}): InstallReport {
  const steps = installSteps(plan);
  if (options.dryRun) {
    return {
      steps,
      agents: [],
      timeMachine: secretPaths(plan.root).map((entry) => ({ path: entry.absolute, excluded: false })),
      exclusionsFile: '',
    };
  }

  for (const dir of [backupsDir(plan.root), logsDir(plan.root)]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1) 常驻服务 3 个 agent：直连（根路径）、子路径（nginx 目标）、每日热备
  //    —— 三个独立 agent：一个崩了不该牵连另一个
  const base = {
    root: plan.root,
    nodePath: plan.nodePath,
    port: plan.port,
    subPathPort: plan.subPathPort,
    mountPath: plan.mountPath,
    dbPath: plan.dbPath,
    keep: plan.keep,
  };
  // 直连实例：BASE_PATH=/（S10 的「直连 http://<host>.local:8787」）
  const server = loadAgent(SERVER_LABEL, buildServerPlist({ ...base, label: SERVER_LABEL, listenPort: plan.port, basePath: '/' }));
  // 子路径实例：BASE_PATH=<mountPath>（nginx 不剥前缀写法）
  const subpath = loadAgent(
    SUBPATH_LABEL,
    buildServerPlist({ ...base, label: SUBPATH_LABEL, listenPort: plan.subPathPort, basePath: plan.mountPath }),
  );
  const backup = loadAgent(BACKUP_LABEL, buildBackupPlist(base));

  // 2) nginx 片段：先 `-t` 再 reload，绝不在语法不过时把宿主 nginx 打挂
  let nginx: InstallReport['nginx'];
  const confPath = nginxEntryConfPath();
  if (confPath !== undefined) {
    const target = installNginxFragment({
      serversDir: path.dirname(confPath),
      // 反代目标是**子路径实例**（BASE_PATH 与挂载点一致，前缀由 app 自己服务）
      fragment: renderNginxLocation({ port: plan.subPathPort, mountPath: plan.mountPath }),
      root: plan.root,
      // 定位 host 那个 server block 用 nginx 的端口（8080），不是 app 的 8787/8786
      listenPort: nginxListenPort(),
    });

    // 2b) 导航页：把 `root html` 从 Homebrew 的**版本目录**改到稳定目录，并把
    //     仓库里生成的导航页写过去。见 `landing.ts` 与 `retargetLandingRoot` 的注释：
    //     版本目录在 `brew upgrade nginx` 后会换名，导航页的改动会静默消失。
    installLandingPage({ root: plan.root, mountPath: plan.mountPath, subPathPort: plan.subPathPort });

    const check = nginxConfigOk(options.nginxBin);
    if (!check.ok) {
      // 撤掉自己两处改动（include 行 + 导航页 root）：宿主配置回到改动前的状态，问题留给人看。
      // **两处都要撤**：只撤 include 而留下一行改过的 root，会让导航页指向一个可能不存在的目录
      uninstallNginxFragment();
      uninstallLandingRoot({ confPath });
      throw new Error(`nginx 配置未通过检查，已撤销改动：\n${check.message}`);
    }
    nginxReload(options.nginxBin);
    nginx = { target, reloaded: true };
  }

  // 3) 密钥权限
  const envMode = ensureEnvMode(plan.root);

  // 4) 双备份通道的排除
  const timeMachine = secretPaths(plan.root).map((entry) => ({
    path: entry.absolute,
    excluded: excludeFromTimeMachine(entry.absolute),
  }));

  // 5) 排除清单落文件（换机后照它重加）
  const exclusionsFile = path.join(plan.root, 'deploy', 'tm-exclusions.txt');
  fs.mkdirSync(path.dirname(exclusionsFile), { recursive: true });
  // 写文件时报告的是**最终**状态：excludeFromTimeMachine 的返回值是「本次是否改动」，
  // 而清单要回答的是「现在排除了没有」（刚排除的与早就排除的都算已排除）
  fs.writeFileSync(
    exclusionsFile,
    renderExclusionsFile(
      plan.root,
      secretPaths(plan.root).map((entry) => ({
        path: entry.absolute,
        excluded: isTimeMachineExcluded(entry.absolute),
      })),
    ),
  );
  return {
    steps,
    agents: [
      { label: SERVER_LABEL, plistPath: server.plistPath, reloaded: server.reloaded },
      { label: SUBPATH_LABEL, plistPath: subpath.plistPath, reloaded: subpath.reloaded },
      { label: BACKUP_LABEL, plistPath: backup.plistPath, reloaded: backup.reloaded },
    ],
    nginx,
    envMode,
    timeMachine,
    exclusionsFile,
  };
}

export interface UninstallReport {
  agents: { label: string; plistPath: string; removedPlist: boolean }[];
  nginxRemoved: boolean;
  /** 被撤掉 include 的宿主配置文件（人核对用） */
  nginxConfPath?: string;
  /** 卸载后**仍然**处于排除状态的路径（含刻意保留的密钥路径，见 `retainedExclusions`） */
  timeMachine: { path: string; excluded: boolean }[];
  /** 保留下来的东西（明确告知，避免误以为卸载把数据也清了） */
  kept: string[];
}

/**
 * 卸载：撤销 launchd 装载、删掉写进宿主 nginx 的 include、**保留**密钥与日志的备份排除。
 *
 * **不删数据**：数据库、热备、`.env` 都留着。卸载服务不该顺手销毁家里的餐史——
 * 真要删数据是另一件需要人明确点头的事。
 *
 * **密钥与日志的 Time Machine 排除继续留着**（不是撤销）：`.env` 还在盘上（见 `kept`），
 * 撤销排除等于把密钥放回整机备份——spec §4 明确要求排除出双通道。
 */
export function uninstall(options: { root: string; nginxBin?: string } = { root: '' }): UninstallReport {
  const agents = [SERVER_LABEL, SUBPATH_LABEL, BACKUP_LABEL].map((label) => ({ label, ...unloadAgent(label) }));

  const { confPath, includeRemoved } = uninstallNginxFragment();
  if (confPath !== undefined) uninstallLandingRoot({ confPath });
  if (includeRemoved) {
    const check = nginxConfigOk(options.nginxBin);
    if (check.ok) nginxReload(options.nginxBin);
  }

  // 排除项：密钥与日志的排除**保留**（.env 仍在盘上）；只确认状态，不动它
  const timeMachine = reassertRetainedExclusions(options.root);

  return {
    agents,
    nginxRemoved: includeRemoved,
    nginxConfPath: confPath,
    timeMachine,
    kept: [path.join(options.root, 'data'), backupsDir(options.root), path.join(options.root, '.env')],
  };
}

/**
 * 卸载时哪些路径**必须继续留在排除名单里**（即使服务已停）。
 *
 * 卸载**不能**把 `.env` 重新放回整机备份：spec §4 原文要求「`.env`（chmod 600）存放 DashScope key；
 * 排除出 Time Machine 与 SQLite 热备双通道」。卸载只是停服务，`.env` **仍在盘上**
 * （正是 `kept` 里声明保留的那份）——把它从排除名单里拿掉，下一次整机备份就会把密钥收进去。
 *
 * 判据是「这个文件在我们仓库里吗」而不是「服务还在跑吗」：只要 `.env` 还在，就继续排除。
 */
export function retainedExclusions(root: string): string[] {
  return secretPaths(root)
    .filter((entry) => fs.existsSync(entry.absolute))
    .map((entry) => entry.absolute);
}

/**
 * 卸载后**重新确认**保留项的排除状态（幂等：已排除就不动）。
 *
 * 为什么卸载还要「加」排除：如果上一次装机时排除失败（权限、Time Machine 未配）
 * 而这次卸载成功了，那卸载后重设一次能让状态回到应然。失败静默——卸载不该因它而失败。
 */
function reassertRetainedExclusions(root: string): { path: string; excluded: boolean }[] {
  return retainedExclusions(root).map((target) => {
    if (!isTimeMachineExcluded(target)) {
      try {
        excludeFromTimeMachine(target);
      } catch {
        // 静默：卸载已完成了主要工作，排除项是尽力而为
      }
    }
    return { path: target, excluded: isTimeMachineExcluded(target) };
  });
}
