/**
 * 每日 SQLite 热备（spec §7、S10）：`sqlite3 .backup` 到 `backups/`，按日滚动保留 N 份。
 *
 * 为什么用 **`sqlite3` CLI 的 `.backup`** 而不是 `cp`、也不引 better-sqlite3 的在线备份 API：
 * spec §7 点名的就是它，且 macOS 自带 `/usr/bin/sqlite3`（`sqliteBinary()` 会探测，preflight 已核实可用），
 * 零新依赖。**关键差别是 `cp` 会漏数据**：库跑在 WAL 模式（`db/index.ts` 的
 * `journal_mode = WAL`），最近写入先落 `-wal`，直接复制 `.db` 会得到一份**缺最新数据却
 * 看起来正常**的备份——最坏的一种备份。`.backup` 走 SQLite 自己的备份 API，读得穿 WAL。
 *
 * 「按日滚动」的键是**日期**（文件名里的 `YYYY-MM-DD`），所以同一天重复跑只覆盖当天那一份。
 * 保留份数用 `KEEP_DEFAULT`，可用 `--keep` 覆盖。
 *
 * 恢复步骤见 `docs/deploy/README.md`；本文件只负责「产出备份 + 滚动」。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backupFileDate, backupFileName, backupsDir } from './paths.js';

/** 缺省保留份数（「滚动保留 N 份」的 N；spec 未指定个数，7 份 ≈ 一周） */
export const KEEP_DEFAULT = 7;

/**
 * `sqlite3` 可执行文件。
 *
 * 优先 `/usr/bin/sqlite3`（macOS 自带，spec §7 说的就是这个），但**不写死**：
 * 用 `existsSync` 确认，否则回落到 PATH 里的 `sqlite3`（Linux/自装情形）。
 * 都不行就返回 `sqlite3` 让 exec 报「命令不存在」——那比我的猜测更准确。
 */
export function sqliteBinary(): string {
  const override = process.env.SQLITE3_BIN?.trim();
  if (override) return override;
  for (const candidate of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'sqlite3';
}

/** 单次 `.backup` 的时间上限。备份是本地文件操作，超过这个数说明是卡在锁上，宁可报错也不要挂住 launchd */
const BACKUP_TIMEOUT_MS = 30_000;

export interface BackupEntry {
  fileName: string;
  filePath: string;
  /** 文件名里的日期标签（家庭时区的今天） */
  date: string;
  bytes: number;
}

/** 某个库文件旁边的 `-wal` / `-shm` 侧文件（`sqlite3` 打开它时会产生） */
function sideFiles(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

/** 删掉库文件旁边的侧文件（滚动与失败清理都要用：它们不匹配备份命名形状，自己不会被清） */
export function removeSideFiles(dbPath: string): void {
  for (const file of sideFiles(dbPath)) fs.rmSync(file, { force: true });
}

export interface BackupResult extends Omit<BackupEntry, 'date'> {
  date: string;
  /** 本次滚动删掉的日期标签（从旧到新） */
  pruned: string[];
}

/**
 * 现有热备，按日期**从新到旧**排列。
 *
 * 只认 `dinner-YYYY-MM-DD.db` 这个形状：`backups/` 是数据目录，用户可能往里放别的东西
 * （手工备份、说明文件），把认不出的文件算进滚动就会删掉别人放的文件。
 */
export function listBackups(root: string): BackupEntry[] {
  const dir = backupsDir(root);
  if (!fs.existsSync(dir)) return [];

  const entries: BackupEntry[] = [];
  for (const fileName of fs.readdirSync(dir)) {
    const date = backupFileDate(fileName);
    if (date === undefined) continue;
    const filePath = path.join(dir, fileName);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    entries.push({ fileName, filePath, date, bytes: stat.size });
  }
  // 日期是定长 'YYYY-MM-DD'，字典序即时间序；倒序 = 从新到旧
  return entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * 决定该删哪些日期：保留最新的 `keep` 个，其余按**从旧到新**返回。
 *
 * 输入顺序不影响判定（按日期排序后再切），所以它可以被单独测——不用先造一堆文件。
 */
export function planPrune(dates: string[], keep: number): string[] {
  const sorted = [...new Set(dates)].sort();
  if (keep <= 0) return sorted;
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

export interface BackupOptions {
  /** 生产库路径（`DB_PATH`） */
  dbPath: string;
  /** 仓库根（`backups/` 就落在这里） */
  root: string;
  /** 家庭时区的今天，'YYYY-MM-DD'（由调用方用 `familyDate(clock.now())` 现算，不在这里 new Date()） */
  today: string;
  keep?: number;
}

/**
 * 跑一次热备：写 `backups/dinner-<today>.db`，然后按日滚动。
 *
 * 先写临时文件再改名：`.backup` 中途失败（锁超时、磁盘满）时**不会**把当天那份
 * 已被覆盖成半截文件——宁可留一个 `*.tmp` 让人看见，也不要一份看着正常的坏备份。
 */
export function runBackup(options: BackupOptions): BackupResult {
  const { dbPath, root, today } = options;
  const keep = options.keep ?? KEEP_DEFAULT;

  // `sqlite3 <不存在的路径>` 会**建一个新的空库**并备份成功——那会得到一个「成功」的空备份，
  // 比失败更糟。所以这里先自己确认源库在。
  if (!fs.existsSync(dbPath)) {
    throw new Error(`源库不存在，拒绝备份：${dbPath}`);
  }

  const dir = backupsDir(root);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = backupFileName(today);
  const filePath = path.join(dir, fileName);
  const tmpPath = `${filePath}.tmp`;

  // `.backup` 输出的是 SQLite 的一个**普通库文件副本**，但 **不重置 journal_mode**——
  // 源库是 WAL（`db/index.ts` 的 `journal_mode = WAL`），所以备份文件也是 WAL。
  // 后果：任何人（包括恢复演练、`sqlite3 <备份>` 读一下）打开它都会在**备份目录里**
  // 留下 `-shm` / `-wal` 侧文件，而且它们不匹配 `dinner-YYYY-MM-DD.db` 这个形状，
  // 滚动保留不会清——日子一长备份目录就堆满垃圾。所以在备份后立刻把它设回 `delete`：
  // 备份文件是**冷藏的快照**，不需要并发写入，journal 模式用传统形态最干净。
  try {
    execFileSync(sqliteBinary(), [dbPath, `.backup '${tmpPath.replace(/'/g, "''")}'`], {
      stdio: 'pipe',
      timeout: BACKUP_TIMEOUT_MS,
    });
    // 复位 journal_mode 这一步自己也会在 `tmp` 旁边留下侧文件（写库就要开日志），
    // 所以复位之后再清一次——否则备份目录里会留下 `*.db.tmp-shm` 这种孤儿
    execFileSync(sqliteBinary(), [tmpPath, 'PRAGMA journal_mode = delete;'], {
      stdio: 'pipe',
      timeout: BACKUP_TIMEOUT_MS,
    });
    removeSideFiles(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    removeSideFiles(tmpPath);
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }

  // 重命名之后也可能残留（名字跟着 tmp 走），两处都清一次成本极低
  removeSideFiles(filePath);

  const pruned = planPrune(
    listBackups(root).map((entry) => entry.date),
    keep,
  );
  for (const date of pruned) {
    const path_ = path.join(dir, backupFileName(date));
    fs.rmSync(path_, { force: true });
    removeSideFiles(path_);
  }

  return {
    fileName,
    filePath,
    date: today,
    bytes: fs.statSync(filePath).size,
    pruned,
  };
}
