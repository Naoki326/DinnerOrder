/**
 * launchd 配置的**生成**（spec §7、S10）：两个 LaunchAgent —— 常驻服务与每日热备。
 *
 * 为什么是生成而不是仓库里放两份写死的 plist：plist 里的绝对路径随机器而变
 * （仓库根、node 路径、日志目录），写死一份要么在别人机器上跑不起来、要么要人手改三处再手抄一遍。
 * 生成的好处是**同一份真相**：`install` 用 `buildServerPlist()` 的产物去装载，
 * 测试断言的是同一个函数的输出——所以「装了但跑不起来」这类错在测试里就会露出来。
 *
 * 两条容易踩的 launchd 细节（都在测试里有对应断言）：
 *
 * 1. **`ProgramArguments` + `WorkingDirectory` 缺一不可**。`node` 与脚本都用绝对路径，
 *    但 app 自己按 cwd 解析相对路径（`server/src/config.ts` 的 `REPO_ROOT` 是从模块自身定位的，
 *    这条是好的），而 launchd 缺省 cwd 是 `/`——所以显式给 `WorkingDirectory`，
 *    让「人在终端里跑 `pnpm start`」与「launchd 跑」两条路看到同一个世界。
 * 2. **`KeepAlive` 要能分辨「崩溃」与「正常退出」**。缺省 `true` 会在进程按 SIGTERM 正常停止后
 *    立刻把它拉起来（`launchctl kickstart -k` 重启时也会抖一下）。用 `SuccessfulExit: false`
 *    （即 `KeepAlive` 字典型）才是「崩了拉起来、正常退出就歇着」——这就是 AC 说的「崩溃自动拉起」。
 *
 * 热备那个用 `StartCalendarInterval`，**不是**常驻进程：它是每天跑一次的批处理。
 */
import path from 'node:path';
import { LAUNCHD_LABEL, logsDir } from './paths.js';

/** 常驻服务的 LaunchAgent 标签 */
export const SERVER_LABEL = LAUNCHD_LABEL;
/**
 * **子路径实例**的 LaunchAgent 标签。
 *
 * 为什么需要两个进程（而不是一个）：一个进程只能有一个 `BASE_PATH`，而 S10 要求
 * **两条通道同时可用**：
 *   * 直连兜底 `http://<host>.local:8787` —— 需要 `BASE_PATH=/`（根路径）；
 *   * nginx 子路径 `/apps/dinner/` —— 需要 `BASE_PATH=/apps/dinner`（不剥前缀）。
 *
 * 两者不可能由一个进程同时满足（`BASE_PATH` 是启动配置）。也不能让 nginx 侧走
 * 「剥前缀 + BASE_PATH=/」：那样 8080 上本 app 的前端会去请求根路径的 `/api/*`，
 * 而那个 location 属于 pi-web——实测需要额外 4 条 location 才能跑通，还会抢别人的 API 流量。
 *
 * 所以：**8787 根路径**（直连、也是给人手工排查的那个）+ **8786 子路径**（nginx 反代目标）。
 * 两个进程共用一个 SQLite 文件——WAL 模式支持多进程读写，写锁竞争由
 * `db/index.ts` 的 `busy_timeout = 5000` 兑付；家里多个人的写入频率下，这比强行单实例
 * 牺牲一条通道更划算。
 */
export const SUBPATH_LABEL = `${LAUNCHD_LABEL}.subpath`;
/** 每日热备的 LaunchAgent 标签（与常驻服务分属两个 agent：一个崩了不该牵连另一个） */
export const BACKUP_LABEL = `${LAUNCHD_LABEL}.backup`;

export interface PlistOptions {
  /** 仓库根（绝对路径） */
  root: string;
  /** node 可执行文件（绝对路径；launchd 不读 PATH，写 `node` 会找不到） */
  nodePath: string;
  /** 直连实例的监听端口（根路径，`BASE_PATH=/`） */
  port: number;
  /** 子路径实例的监听端口（`BASE_PATH=<mountPath>`，作 nginx 反代目标） */
  subPathPort: number;
  /** 挂载前缀（ADR-0003）：**只给子路径实例**用；直连实例恒为 `/` */
  mountPath: string;
  /** 数据库文件（相对仓库根或绝对路径；两个实例**同一个库**） */
  dbPath: string;
  /** 热备保留份数 */
  keep: number;
}

/** XML 文本转义：路径里出现 `&` 或 `<`（目录名带这些字符并不罕见）会让 plist 解析失败 */
function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stringKey(key: string, value: string, indent = '\t'): string {
  return `${indent}<key>${key}</key>\n${indent}<string>${xml(value)}</string>`;
}

function plistDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

/**
 * 常驻服务的 plist：开机自启（RunAtLoad）+ 崩溃自动拉起（KeepAlive.SuccessfulExit=false）。
 *
 * 环境变量写进 plist 而不是只靠 `.env`：`.env` 由 `node --env-file-if-exists` 读，
 * 但 `--env-file` 是**文件**——plist 里再钉一遍端口/库路径/挂载点，是为了让「服务挂在哪儿、
 * 用哪个库」在 `launchctl print` 里直接看得见（排障时不必去猜 `.env` 被谁改过）。
 * 真实 shell 环境变量优先级高于文件（`config.ts`），所以两处不一致时以 plist 为准——这是刻意的。
 *
 * `label`/`basePath` 是参数：同一个 shape 既装直连实例（`BASE_PATH=/`）也装子路径实例。
 */
export function buildServerPlist(
  options: PlistOptions & { label?: string; basePath?: string; listenPort?: number },
): string {
  const { root, nodePath } = options;
  const label = options.label ?? SERVER_LABEL;
  const port = options.listenPort ?? options.port;
  // 直连实例恒为根路径；子路径实例传 mountPath
  const basePath = options.basePath ?? '/';
  const entry = path.join(root, 'server', 'dist', 'index.js');
  const env = [
    ['PORT', String(port)],
    ['HOST', '0.0.0.0'],
    ['DB_PATH', options.dbPath],
    ['BASE_PATH', basePath],
  ] as const;

  const body = [
    stringKey('Label', label),
    '\t<key>ProgramArguments</key>\n\t<array>',
    `\t\t<string>${xml(nodePath)}</string>`,
    '\t\t<string>--env-file-if-exists=.env</string>',
    `\t\t<string>${xml(entry)}</string>`,
    '\t</array>',
    stringKey('WorkingDirectory', root),
    '\t<key>EnvironmentVariables</key>\n\t<dict>',
    ...env.map(([key, value]) => `\t\t<key>${key}</key>\n\t\t<string>${xml(value)}</string>`),
    '\t</dict>',
    '\t<key>RunAtLoad</key>\n\t<true/>',
    // 崩了拉起、正常退出就歇着：见文件头「两条容易踩的细节」
    '\t<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>',
    '\t<key>ThrottleInterval</key>\n\t<integer>10</integer>',
    // 两个实例的日志分文件：否则 `server.err.log` 里两条启动行混在一起，排障时分不清谁是谁
    stringKey('StandardOutPath', path.join(logsDir(root), `${label}.out.log`)),
    stringKey('StandardErrorPath', path.join(logsDir(root), `${label}.err.log`)),
  ].join('\n');

  return plistDocument(body);
}

/**
 * 每日热备的 plist：`StartCalendarInterval` 每天 03:00 跑一次（夜间没人定餐，锁冲突最小）。
 *
 * **不做 RunAtLoad**：开机就立刻备一次会让「今天那份」被重启覆盖成开机时刻的形态，
 * 而备份的价值在于「每天同一时刻的快照」。缺一次开机当天的备份无害，多一次无意义的覆盖才烦。
 */
export function buildBackupPlist(options: PlistOptions): string {
  const { root, nodePath, dbPath, keep } = options;
  const entry = path.join(root, 'server', 'dist', 'deploy', 'backup-cli-entry.js');

  const body = [
    stringKey('Label', BACKUP_LABEL),
    '\t<key>ProgramArguments</key>\n\t<array>',
    `\t\t<string>${xml(nodePath)}</string>`,
    `\t\t<string>${xml(entry)}</string>`,
    '\t\t<string>--db</string>',
    `\t\t<string>${xml(dbPath)}</string>`,
    '\t\t<string>--keep</string>',
    `\t\t<string>${keep}</string>`,
    '\t</array>',
    stringKey('WorkingDirectory', root),
    '\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>3</integer>\n\t\t<key>Minute</key>\n\t\t<integer>0</integer>\n\t</dict>',
    stringKey('StandardOutPath', path.join(logsDir(root), 'backup.out.log')),
    stringKey('StandardErrorPath', path.join(logsDir(root), 'backup.err.log')),
  ].join('\n');

  return plistDocument(body);
}

/**
 * 备份**必须排除**的路径（双备份通道：Time Machine 整机 + 这份热备）。
 *
 * spec §4/§7：`.env` 存 LLM key，**排除出两条通道**；`DEBUG=1` 时的完整请求/响应落
 * `data/logs/`（里面可能带用户输入与菜谱正文），同样随 `.env` 一起排除。
 *
 * 热备这一侧是「本来就不含」——它只备**数据库文件**，`.env` 与 `data/logs/` 不在其中。
 * 返回这份清单是为了让 Time Machine 那一侧有据可依（`deploy/tm-exclusions.txt`），
 * 也让「排除了哪些」在一个地方说得清，而不是散在文档里的几句话。
 */
export function backupExclusions(root: string): string[] {
  return [path.join(root, '.env'), logsDir(root)];
}
