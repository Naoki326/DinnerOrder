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
    root: REPO_ROOT,
    today: options.today ?? todayInFamilyZone(now),
    keep: options.keep,
  });
}
