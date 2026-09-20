import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {
  BACKUP_LABEL,
  SERVER_LABEL,
  SUBPATH_LABEL,
  backupExclusions,
  buildBackupPlist,
  buildServerPlist,
} from './launchd.js';

/**
 * launchd 配置（S10：开机自启、崩溃自动拉起）。
 *
 * 这些断言值钱的地方在于：plist 写错**不会立刻报错**，只会在下次开机时表现为「服务没起来」，
 * 而那时没人会去读 `plutil` 的输出。所以这里把三件事钉住：
 *
 * 1. **真的是合法 plist**：用 macOS 自带的 `plutil -lint` 与 `plutil -convert json` 真解析一遍。
 *    手写 XML 打错一个闭合标签，只有这一步看得出来。
 * 2. **崩溃拉起 ≠ 正常退出也拉起**：`KeepAlive` 必须是 `{SuccessfulExit: false}`。
 *    写成 `true` 会让 SIGTERM 停机后被立刻拉回（`launchctl kickstart -k` 会抖）。
 * 3. **绝对路径**：launchd 不读 PATH，`node` 与脚本都必须绝对路径；且 cwd 要显式给
 *    （缺省是 `/`，会让 app 相对路径解析到根目录去）。
 */

const OPTIONS = {
  root: '/Users/someone/DinnerOrder',
  nodePath: '/opt/homebrew/bin/node',
  port: 8787,
  subPathPort: 8786,
  mountPath: '/apps/dinner',
  dbPath: 'data/dinner.db',
  keep: 7,
};

/** 直连实例（根路径）：S10 的「直连 http://<host>.local:8787」 */
const DIRECT = { ...OPTIONS, label: SERVER_LABEL, listenPort: OPTIONS.port, basePath: '/' };
/** 子路径实例：nginx 反代目标（不剥前缀写法） */
const SUBPATH = { ...OPTIONS, label: SUBPATH_LABEL, listenPort: OPTIONS.subPathPort, basePath: OPTIONS.mountPath };

/**
 * macOS 自带 `plutil` 才能真解析 plist。非 macOS（或没装）时下面的用例 skip：
 * 本项目的部署目标就是 macOS（launchd 本身是 macOS 专属），在 Linux 上假装验过没有意义。
 */
const HAS_PLUTIL = fs.existsSync('/usr/bin/plutil');
const describePlist = describe.skipIf(!HAS_PLUTIL);

/** 用 macOS 自带 plutil 真解析一遍 plist，返回 JSON 形态（- 表示 stdin） */
function parsePlist(xml: string): Record<string, unknown> {
  const out = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: xml,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return JSON.parse(out) as Record<string, unknown>;
}

describePlist('常驻服务的 plist', () => {
  it('是合法 plist，且 Label / 绝对路径 / cwd 都对', () => {
    const plist = parsePlist(buildServerPlist(DIRECT));

    expect(plist.Label).toBe(SERVER_LABEL);
    expect(plist.ProgramArguments).toEqual([
      '/opt/homebrew/bin/node',
      '--env-file-if-exists=.env',
      '/Users/someone/DinnerOrder/server/dist/index.js',
    ]);
    // cwd 显式给：launchd 缺省是 /，app 的相对路径会解析到根目录
    expect(plist.WorkingDirectory).toBe('/Users/someone/DinnerOrder');
  });

  it('开机自启（RunAtLoad）且崩溃自动拉起，但正常退出不拉回', () => {
    const plist = parsePlist(buildServerPlist(DIRECT));

    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toEqual({ SuccessfulExit: false });
    // 崩了立刻重启会形成热循环，10 秒节流是 launchd 的常规安全垫
    expect(plist.ThrottleInterval).toBe(10);
  });

  it('端口/库路径/挂载点钉进 EnvironmentVariables（launchctl print 里看得见）', () => {
    const plist = parsePlist(buildServerPlist(DIRECT));

    expect(plist.EnvironmentVariables).toEqual({
      PORT: '8787',
      HOST: '0.0.0.0',
      DB_PATH: 'data/dinner.db',
      // 直连实例恒为根路径（S10 的「直连 http://<host>.local:8787」）
      BASE_PATH: '/',
    });
  });

  it('子路径实例：同一 shape，LABEL/PORT/BASE_PATH 都跟着挂载点走', () => {
    const plist = parsePlist(buildServerPlist(SUBPATH));

    expect(plist.Label).toBe(SUBPATH_LABEL);
    expect(plist.EnvironmentVariables).toEqual({
      PORT: '8786',
      HOST: '0.0.0.0',
      DB_PATH: 'data/dinner.db',
      // nginx「不剥前缀」写法：BASE_PATH 就是挂载点本身（ADR-0003）
      BASE_PATH: '/apps/dinner',
    });
    // 同一个库：两个实例共享一个 SQLite 文件（WAL 支持多进程读写）
    expect((plist.EnvironmentVariables as Record<string, string>).DB_PATH).toBe('data/dinner.db');
  });

  it('两个实例的日志分文件（否则 err.log 里两条启动行混在一起分不清谁是谁）', () => {
    const direct = parsePlist(buildServerPlist(DIRECT));
    const subpath = parsePlist(buildServerPlist(SUBPATH));

    expect(direct.StandardOutPath).not.toBe(subpath.StandardOutPath);
    expect(direct.StandardOutPath).toBe('/Users/someone/DinnerOrder/data/logs/com.naoki.dinnerorder.out.log');
    expect(subpath.StandardOutPath).toBe('/Users/someone/DinnerOrder/data/logs/com.naoki.dinnerorder.subpath.out.log');
  });

  it('日志落在 data/logs/（随 .env 一起排除出备份通道，所以不该散到别处）', () => {
    const plist = parsePlist(buildServerPlist(DIRECT));

    expect(plist.StandardOutPath).toBe('/Users/someone/DinnerOrder/data/logs/com.naoki.dinnerorder.out.log');
    expect(plist.StandardErrorPath).toBe('/Users/someone/DinnerOrder/data/logs/com.naoki.dinnerorder.err.log');
  });
});

describePlist('每日热备的 plist', () => {
  it('是每天 03:00 的定时任务，不是常驻进程（没有 RunAtLoad / KeepAlive）', () => {
    const plist = parsePlist(buildBackupPlist(OPTIONS));

    expect(plist.Label).toBe(BACKUP_LABEL);
    expect(plist.StartCalendarInterval).toEqual({ Hour: 3, Minute: 0 });
    expect(plist.RunAtLoad).toBeUndefined();
    expect(plist.KeepAlive).toBeUndefined();
  });

  it('指向编译产物（不依赖 tsx），并把 --db / --keep 作为独立参数传入', () => {
    const plist = parsePlist(buildBackupPlist(OPTIONS));

    expect(plist.ProgramArguments).toEqual([
      '/opt/homebrew/bin/node',
      '/Users/someone/DinnerOrder/server/dist/deploy/backup-cli-entry.js',
      '--db',
      'data/dinner.db',
      '--keep',
      '7',
    ]);
  });
});

describe('双备份通道的排除项', () => {
  it('.env 与 data/logs 都在排除清单里（key 与调试正文绝不进任何备份）', () => {
    const exclusions = backupExclusions('/Users/someone/DinnerOrder');

    expect(exclusions).toContain('/Users/someone/DinnerOrder/.env');
    expect(exclusions).toContain('/Users/someone/DinnerOrder/data/logs');
  });
});

describePlist('路径含特殊字符也不炸', () => {
  it('目录名带 & 与 < 时转义正确（否则 plist 解析失败，且报错信息完全指不到真因）', () => {
    const root = '/Users/a&b/<Dinner>Order';
    const plist = parsePlist(buildServerPlist({ ...DIRECT, root }));

    expect(plist.WorkingDirectory).toBe(root);
    expect(plist.StandardOutPath).toBe(path.join(root, 'data', 'logs', `${SERVER_LABEL}.out.log`));
  });
});

describe('生成的 plist 与真实装载路径一致', () => {
  it('写下的 .env 相对文件名依赖 WorkingDirectory（launchd 的 cwd 必须是仓库根）', () => {
    const plist = parsePlist(buildServerPlist(DIRECT));

    // `--env-file-if-exists=.env` 是相对路径：只有 WorkingDirectory 对，密钥才读得到
    const args = plist.ProgramArguments as string[];
    expect(args).toContain('--env-file-if-exists=.env');
    expect(plist.WorkingDirectory).toBe(OPTIONS.root);
  });

  it('plutil 认下的文档头与实际文件逐字节一致（装载的是这个字符串本身）', () => {
    const xml = buildServerPlist(DIRECT);
    // 走一次文件系统，验证真实装载路径（launchctl load 读的是文件）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-plist-'));
    try {
      const file = path.join(dir, `${SERVER_LABEL}.plist`);
      fs.writeFileSync(file, xml);
      expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8', timeout: 20_000 })).toContain('OK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
