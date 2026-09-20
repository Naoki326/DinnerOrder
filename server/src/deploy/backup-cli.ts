/**
 * 每日热备的 CLI 逻辑（与 `scripts/backup.ts` 的入口分开：这里全是可测的纯函数）。
 *
 * 为什么参数解析也要有测试：launchd 就是照这套参数调它的，而「路径按仓库根解析」
 * 这类约定一旦漂移（launchd 的 cwd 是 `/`），热备会写到家目录去——文件确实生成了，
 * 但不在备份通道里，等于没备份。
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../config.js';
import { familyDate } from '../domain/family-time.js';
import { KEEP_DEFAULT, runBackup, type BackupResult } from './backup.js';

export interface CliOptions {
  dbPath: string;
  /**
   * 备份通道所在的根（`backups/` 落在它下面）。缺省是仓库根——launchd 不传它，行为不变。
   * 为什么 CLI 需要这个口子：域层 `runBackup` 本来就接受 `root`，但 CLI 写死 `REPO_ROOT` 后，
   * 测试（`backup-cli.test.ts` 走编译产物那条路）就只能把夹具备份写进仓库的 `backups/`——
   * 那是真实的恢复通道，测试写进去会**同名覆盖当天的真实备份**，且退出码 0、毫无整告。
   */
  root: string;
  keep: number;
  /** 覆盖「今天」（家庭时区）。只给测试用，正常调用不传 */
  today?: string;
  json: boolean;
}

/**
 * 相对路径一律按**仓库根**解析，不是 cwd：launchd 拉起进程时 cwd 可能是 `/` 或家目录，
 * 用 cwd 会让 `--db data/dinner.db` 落到意想不到的地方（`server/src/config.ts` 的 REPO_ROOT
 * 同一理由）。绝对路径原样保留。
 */
export function resolveFromRoot(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) return path.resolve(REPO_ROOT, fallback);
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

export function parseOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      keep: { type: 'string' },
      today: { type: 'string' },
      root: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const keep = values.keep === undefined ? KEEP_DEFAULT : Number.parseInt(values.keep, 10);
  // 拒绝而不是回落到缺省：`--keep 0` 会删掉全部历史备份，写错一个数字的代价太大
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep 必须是 ≥1 的整数，收到：${JSON.stringify(values.keep)}`);
  }

  return {
    dbPath: resolveFromRoot(values.db, 'data/dinner.db'),
    // 缺省直接用常量本身（不二次 resolve：REPO_ROOT 带目录尾部斜杠，重新解析会得到
    // 规范化后的另一形式）；相对路径才需要按仓库根解析（与 --db 同一套理由：launchd 的 cwd 不可信）
    root: values.root === undefined ? REPO_ROOT : resolveFromRoot(values.root, REPO_ROOT),
    keep,
    today: values.today,
    json: values.json ?? false,
  };
}

/** 家庭时区的今天——「按日滚动」的日期键必须与餐槽判定同一个时区（`domain/family-time.ts`） */
export function todayInFamilyZone(now: Date = new Date()): string {
  return familyDate(now);
}

export function executeBackup(options: CliOptions, now: Date = new Date()): BackupResult {
  return runBackup({
    dbPath: options.dbPath,
    root: options.root,
    today: options.today ?? todayInFamilyZone(now),
    keep: options.keep,
  });
}
