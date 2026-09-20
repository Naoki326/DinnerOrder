import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config.js';
import { parseOptions, todayInFamilyZone } from './backup-cli.js';
import { sqliteBinary } from './backup.js';

/**
 * 热备 CLI 的对外契约（launchd 就是照这个调它的）。
 *
 * 这一层值得测的是**入口行为**，不是再测一遍 `runBackup`：参数缺省值、相对路径按仓库根解析、
 * 家庭时区的日期、以及「失败要非零退出」——最后一条尤其重要，因为静默失败的热备
 * 会在需要恢复的那天才暴露。
 *
 * 真跑一遍故意走**编译产物**（`node server/dist/deploy/backup-cli-entry.js`）而不是源码：
 * launchd 每天叫的正是这个文件，而它必须能在「没装 tsx / devDependencies 被清掉」的机器上跑得起来
 * （与 `src/index.ts` 同一路数）。**前提是已 `pnpm build`**；没构建就跳过并说明，不让它变成假绿。
 */

const ENTRY = path.join(REPO_ROOT, 'server', 'dist', 'deploy', 'backup-cli-entry.js');
const built = fs.existsSync(ENTRY);

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-backup-cli-'));
  dbPath = path.join(root, 'dinner.db');
  execFileSync(
    sqliteBinary(),
    [dbPath, 'PRAGMA journal_mode=WAL; CREATE TABLE meals (id INTEGER PRIMARY KEY); INSERT INTO meals VALUES (1);'],
    { timeout: 20_000 },
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [ENTRY, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('参数缺省与解析', () => {
  it('缺省库路径按仓库根解析，而不是 cwd（launchd 的 cwd 可能是 /）', () => {
    expect(parseOptions([]).dbPath).toBe(path.join(REPO_ROOT, 'data', 'dinner.db'));
    expect(parseOptions([]).keep).toBeGreaterThan(0);
  });

  it('相对 --db 也按仓库根解析，绝对路径原样', () => {
    expect(parseOptions(['--db', 'data/custom.db']).dbPath).toBe(path.join(REPO_ROOT, 'data', 'custom.db'));
    expect(parseOptions(['--db', '/tmp/x.db']).dbPath).toBe('/tmp/x.db');
  });

  it('--keep 非法就直接拒绝，不悄悄回落成缺省值', () => {
    expect(() => parseOptions(['--keep', '0'])).toThrow();
    expect(() => parseOptions(['--keep', '七'])).toThrow();
  });
});

describe('日期键', () => {
  it('用家庭时区的今天（跨零点那一晚不能算成昨天，否则滚动的位置会互相覆盖）', () => {
    // UTC 2026-09-19T17:00Z = 家庭时区 2026-09-20 01:00
    expect(todayInFamilyZone(new Date('2026-09-19T17:00:00Z'))).toBe('2026-09-20');
    expect(todayInFamilyZone(new Date('2026-09-19T15:59:00Z'))).toBe('2026-09-19');
  });
});

describe.skipIf(!built)('真跑一遍（launchd 会走的那条命令）', () => {
  it('备份成功、退出码 0，回执里给出备份文件路径与字节数', () => {
    const { status, stdout } = runCli(['--db', dbPath, '--today', '2026-09-20', '--json']);

    expect(status).toBe(0);
    const receipt = JSON.parse(stdout) as { filePath: string; fileName: string; bytes: number };
    expect(receipt.fileName).toBe('dinner-2026-09-20.db');
    expect(fs.existsSync(receipt.filePath)).toBe(true);
    expect(receipt.bytes).toBeGreaterThan(0);
    // 备份里读得到源库的表（不是只有一个空文件）
    expect(
      execFileSync(sqliteBinary(), [receipt.filePath, 'SELECT count(*) FROM meals;'], { encoding: 'utf8' }).trim(),
    ).toBe('1');
  });

  it('源库不存在时非零退出并说明原因（静默失败的热备最危险）', () => {
    const { status, stderr } = runCli(['--db', path.join(root, '没有这个库.db'), '--today', '2026-09-20']);

    expect(status).not.toBe(0);
    expect(stderr).toContain('备份');
    expect(stderr).toContain('不存在');
  });
});
