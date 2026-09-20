/**
 * 部署 CLI 入口：`pnpm deploy:install` / `deploy:uninstall` / `deploy:status`。
 *
 * 三个子命令共用一个入口（避免三份脚本各自解析路径、各自漂移）：
 *   * `install [--dry-run] [--port N] [--mount /apps/dinner] [--keep N]`
 *   * `uninstall`
 *   * `status` —— 只读巡检：服务装载状态、热备清单、密钥权限、排除项、两条访问通道
 *
 * `status` 的存在是为了让「现在到底装成什么样」有一个**可重复**的回答，
 * 而不是靠人回忆上次做了什么。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../config.js';
import { KEEP_DEFAULT, listBackups } from './backup.js';
import { install, isServiceLoaded, launchAgentsDir, uninstall, type InstallPlan } from './install.js';
import { BACKUP_LABEL, SERVER_LABEL, SUBPATH_LABEL, backupExclusions } from './launchd.js';
import { envMode, isTimeMachineExcluded, secretPaths } from './secrets.js';
import { LAUNCHD_PLIST_NAME } from './paths.js';

export interface DeployCliOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** 直连实例端口（根路径，S10 的「直连 http://<host>.local:8787」） */
  port: number;
  /** 子路径实例端口（作 nginx 反代目标） */
  subPathPort: number;
  mountPath: string;
  dbPath: string;
  keep: number;
  json: boolean;
}

const DEFAULT_MOUNT = '/apps/dinner';

/** 直连实例的缺省端口（根路径，S10 的「直连 http://<host>.local:8787」） */
export const DIRECT_PORT_DEFAULT = 8787;
/** 子路径实例的缺省端口（nginx 反代目标） */
export const SUB_PATH_PORT_DEFAULT = 8786;

/**
 * 端口入参校验（两处共用一份：`--port` 与 `--sub-path-port` 的规则必须一致，
 * 各写一遍时改一处忘一处就会让其中一个接受 0 或 70000）。
 */
function parsePort(raw: string | undefined, fallback: number, flag: string): number {
  const port = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag} 必须是 1-65535 的整数，收到：${JSON.stringify(raw)}`);
  }
  return port;
}

export function parseOptions(argv: string[]): DeployCliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      port: { type: 'string' },
      'sub-path-port': { type: 'string' },
      mount: { type: 'string' },
      db: { type: 'string' },
      keep: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const command = (positionals[0] ?? 'status') as DeployCliOptions['command'];
  if (!['install', 'uninstall', 'status'].includes(command)) {
    throw new Error(`未知子命令：${command}（可用：install / uninstall / status）`);
  }

  const port = parsePort(values.port, DIRECT_PORT_DEFAULT, '--port');
  const subPathPort = parsePort(values['sub-path-port'], SUB_PATH_PORT_DEFAULT, '--sub-path-port');

  const keep = values.keep === undefined ? KEEP_DEFAULT : Number.parseInt(values.keep, 10);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep 必须是 ≥1 的整数，收到：${JSON.stringify(values.keep)}`);
  }

  const mountPath = values.mount ?? DEFAULT_MOUNT;
  if (!mountPath.startsWith('/') || mountPath.includes('..') || mountPath.includes('?')) {
    throw new Error(`--mount 必须是绝对路径且不含 '..'/'?'，收到：${JSON.stringify(mountPath)}`);
  }

  return {
    command,
    dryRun: values['dry-run'] ?? false,
    port,
    subPathPort,
    mountPath: mountPath.replace(/\/+$/, ''),
    dbPath: values.db ?? 'data/dinner.db',
    keep,
    json: values.json ?? false,
  };
}

export function planFor(options: DeployCliOptions, root: string = REPO_ROOT): InstallPlan {
  return {
    root,
    nodePath: process.execPath,
    port: options.port,
    subPathPort: options.subPathPort,
    mountPath: options.mountPath,
    dbPath: options.dbPath,
    keep: options.keep,
  };
}

export interface StatusReport {
  serverLoaded: boolean;
  subPathLoaded: boolean;
  backupLoaded: boolean;
  plistPath: string;
  envMode?: number;
  timeMachine: { path: string; excluded: boolean }[];
  backups: { fileName: string; bytes: number }[];
  exclusions: string[];
}

/** 只读巡检：现在装成什么样 */
export function collectStatus(root: string = REPO_ROOT): StatusReport {
  return {
    serverLoaded: isServiceLoaded(SERVER_LABEL),
    subPathLoaded: isServiceLoaded(SUBPATH_LABEL),
    backupLoaded: isServiceLoaded(BACKUP_LABEL),
    plistPath: path.join(launchAgentsDir(), LAUNCHD_PLIST_NAME),
    envMode: envMode(root),
    timeMachine: secretPaths(root).map((entry) => ({ path: entry.absolute, excluded: isTimeMachineExcluded(entry.absolute) })),
    backups: listBackups(root).map((entry) => ({ fileName: entry.fileName, bytes: entry.bytes })),
    exclusions: backupExclusions(root).map((entry) => path.relative(root, entry)),
  };
}

/**
 * 从**已装载的 plist 里现读**某个实例的「BASE_PATH / 端口」描述（给巡检输出用）。
 *
 * 为什么现读而不写死：装机时可以用 `--port` / `--sub-path-port` / `--mount` 改，
 * 写死的口径会让改了端口的部署在巡检里报错（看起来像装错了）。
 *
 * plist 是 XML，但这里只需要两个 key 的值，用 `plutil -convert json` 转一遍再取
 * 比在 TS 里写 XML 解析稳得多（plutil 是 macOS 自带，而 launchd 本来就只有 macOS 有）。
 * 读不出就返回空串，由调用方回落到描述性文案。
 */
function describeAgent(label: string): string {
  const plistPath = path.join(launchAgentsDir(), `${label}.plist`);
  if (!fs.existsSync(plistPath)) return '';
  try {
    const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: 'pipe',
    });
    const parsed = JSON.parse(json) as { EnvironmentVariables?: Record<string, string> };
    const env = parsed.EnvironmentVariables ?? {};
    if (env.BASE_PATH === undefined || env.PORT === undefined) return '';
    return `BASE_PATH=${env.BASE_PATH}，${env.PORT}`;
  } catch {
    return '';
  }
}

function reportStatus(status: StatusReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const mark = (ok: boolean): string => (ok ? '✓' : '✗');
  console.log('家餐桌部署巡检');
  // 端口/挂载点从**已装载的 plist 里现读**，不写死：装机时可以用 --port/--mount 改，
  // 写死的口径会让改了端口的部署在巡检里报错（看起来像装错了）
  console.log(`  ${mark(status.serverLoaded)} 直连服务 ${SERVER_LABEL}（${describeAgent(SERVER_LABEL) || 'BASE_PATH=/，8787'}）`);
  console.log(`  ${mark(status.subPathLoaded)} 子路径服务 ${SUBPATH_LABEL}（${describeAgent(SUBPATH_LABEL) || 'BASE_PATH=<mountPath>'}）`);
  console.log(`  ${mark(status.backupLoaded)} 每日热备 ${BACKUP_LABEL}`);
  console.log(`  plist：${status.plistPath}`);
  console.log(
    `  ${mark(status.envMode === 0o600)} .env 权限：${status.envMode === undefined ? '不存在' : `0o${status.envMode.toString(8)}`}`,
  );
  for (const entry of status.timeMachine) {
    console.log(`  ${mark(entry.excluded)} Time Machine 排除：${entry.path}`);
  }
  console.log(`  热备（${status.backups.length} 份）：${status.backups.map((entry) => entry.fileName).join(', ') || '（还没有）'}`);
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));

  if (options.command === 'status') {
    reportStatus(collectStatus(), options.json);
    return;
  }

  if (options.command === 'uninstall') {
    const report = uninstall({ root: REPO_ROOT });
    console.log(JSON.stringify({ ...report, keptNote: '数据与热备已保留，未删除' }, null, 2));
    return;
  }

  const plan = planFor(options);
  if (options.dryRun) {
    // 走 install(..., {dryRun:true}) 而不是自己拼一份计划：dry-run 与真装**同一条判断路径**，
    // 否则「先空跑看着都对、真跑做了别的事」这种偏差只会在改系统时才暴露
    const preview = install(plan, { dryRun: true });
    if (options.json) {
      console.log(JSON.stringify({ dryRun: true, steps: preview.steps }, null, 2));
      return;
    }
    console.log('将要执行（--dry-run 不会真的改系统）：');
    for (const step of preview.steps) {
      console.log(`  · ${step.action}\n      目标：${step.target.replace(/\n\s*/g, '\n            ')}\n      现状：${step.state}`);
    }
    return;
  }

  const report = install(plan);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const agent of report.agents) {
    console.log(`${agent.reloaded ? '已重装载' : '已装载'} ${agent.label} → ${agent.plistPath}`);
  }
  if (report.nginx) console.log(`nginx 片段已写入并 reload：${report.nginx.target}`);
  if (report.envMode?.changed) console.log(`.env 权限已校正为 0o${(report.envMode.mode ?? 0).toString(8)}`);
  for (const entry of report.timeMachine) {
    console.log(`${entry.excluded ? '已排除' : '（本来就已排除）'} Time Machine：${entry.path}`);
  }
  console.log(`排除清单：${report.exclusionsFile}`);
  console.log(`\n下一步：核对服务起来了 → curl http://127.0.0.1:${plan.port}/api/health`);
  console.log(`         访问入口 → http://${process.env.HOSTNAME ?? '<主机名>'}${plan.mountPath}/`);}

const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[deploy] 失败：${message}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}
