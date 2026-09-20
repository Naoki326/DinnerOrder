import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupFileDate, backupFileName, backupsDir } from './paths.js';
import { listBackups, planPrune, runBackup, sqliteBinary } from './backup.js';

/**
 * 每日 SQLite 热备（spec §7、S10）：`sqlite3 .backup` 到 `backups/`，**按日滚动保留 N 份**。
 *
 * 这里守三条不变式，每条都对应一个真实会出事的地方：
 *
 * 1. **热备不是 `cp`**：WAL 模式下新写的数据还在 `-wal` 侧文件里，直接复制 `.db`
 *    会得到一份**缺最新数据**却看起来正常的备份（最坏的一种备份）。所以用真库真写、
 *    **不 checkpoint** 就备份，断言备份里读得到那些行。
 * 2. **按日 = 一天一份**：同一天重复跑只覆盖当天那一份，不是每跑一次多一份。
 * 3. **滚动只删自己认得的文件**：`backups/` 是数据目录，认不出形状的文件一律留着
 *    （删别人的文件比多留几份旧备份危险得多）。
 */

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-backup-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  dbPath = path.join(root, 'data', 'dinner.db');
  sqlite(dbPath, 'PRAGMA journal_mode=WAL; CREATE TABLE meals (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sqlite(dbPath: string, sql: string): string {
  // `-cmd '.timeout N'` 必须先设：不设时另一个连接持着写锁会让这条查询立刻抛
  // `database is locked`，而不是等一会再试——轮询里那就是「写入永远看不见」的假失败
  // （生产库的 `busy_timeout = 5000` 是 `db/index.ts` 设的，但那是 app 的连接，不是 CLI 的）
  return execFileSync(sqliteBinary(), ['-cmd', '.timeout 5000', dbPath, sql], {
    encoding: 'utf8',
    timeout: 20_000,
  }).trim();
}

/** 让出 CPU 一小段（异步，不阻塞事件循环）。
 *  **不要**用 `while (Date.now() < until) {}` 这种忙等：并发跑到 CPU 饱和时它会把
 *  sqlite 子进程饿死，写入永远完不成——那会让「等写入可见」变成一个假失败
 *  （实测：把 10 轮并发运行会中一次）。 */
const yieldMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** SQLite 的写入在 WAL 模式下不必立刻落到 `-wal` 以外：这里起一个常驻会话写数据然后**不退出**，
 *  让数据停在 WAL 里——正是「正在被写着的库」的形态 */
async function withWalWriter<T>(work: (session: (sql: string) => void) => Promise<T>): Promise<T> {
  const proc = spawn(sqliteBinary(), [dbPath!], { stdio: ['pipe', 'pipe', 'pipe'] });
  // 不读 stdout：只关心写入是否对**其他连接**可见，自己这条会话的输出用不上
  proc.stdout.resume();
  const session = (sql: string): void => {
    proc.stdin.write(`${sql}\n`);
  };
  try {
    return await work(session);
  } finally {
    proc.kill();
  }
}

/** 等一次写入在**独立连接**里可见（有界轮询，最多 4s；每轮让出 CPU） */
async function waitUntilVisible(expected: number): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (Number(sqlite(dbPath!, 'SELECT count(*) FROM meals;')) === expected) return;
    await yieldMs(50);
  }
  throw new Error(`写入在独立连接里始终不可见（期望 ${expected} 行）`);
}

describe('热备文件命名', () => {
  it('日期进文件名，所以「按日滚动」的键是日期而不是「跑第几次」', () => {
    expect(backupFileName('2026-09-20')).toBe('dinner-2026-09-20.db');
    expect(backupFileDate('dinner-2026-09-20.db')).toBe('2026-09-20');
  });

  it('认不出形状的文件名解析为 undefined（滚动时据此放过它们）', () => {
    expect(backupFileDate('dinner-manual.db')).toBeUndefined();
    expect(backupFileDate('dinner-2026-9-2.db')).toBeUndefined();
    expect(backupFileDate('我的手工备份.db')).toBeUndefined();
    expect(backupFileDate('dinner-2026-09-20.db-wal')).toBeUndefined();
  });
});

describe('滚动保留的取舍', () => {
  it('保留最新的 N 个日期，其余按从旧到新列出待删', () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
    expect(planPrune(dates, 3)).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('份数没超上限就一个都不删', () => {
    expect(planPrune(['2026-09-04', '2026-09-05'], 7)).toEqual([]);
  });

  it('输入顺序不影响判定（按日期排序，不按到达顺序）', () => {
    const dates = ['2026-09-05', '2026-09-01', '2026-09-03'];
    expect(planPrune(dates, 2)).toEqual(['2026-09-01']);
  });
});

describe('跑一次热备', () => {
  it('正在被写着的库（数据还在 WAL 里）也备得到最新数据——所以热备不能是 cp', async () => {
    await withWalWriter(async (session) => {
      session('INSERT INTO meals (id, name) VALUES (1, "餐-1"), (2, "餐-2"), (3, "餐-3");');
      await waitUntilVisible(3);

      // 先把「数据确实只在 WAL 里」钉成证据：主文件字节里没有这些行，WAL 里有。
      // 这就是 `cp` 会漏数据的真实形态（文件存在、也能打开，就是少了最新写入）。
      const dbBytes = fs.readFileSync(dbPath);
      const walBytes = fs.readFileSync(`${dbPath}-wal`);
      expect(dbBytes.includes('餐-1')).toBe(false);
      expect(walBytes.includes('餐-1')).toBe(true);

      const result = runBackup({ dbPath, root, today: '2026-09-20', keep: 7 });

      expect(result.fileName).toBe('dinner-2026-09-20.db');
      expect(result.bytes).toBeGreaterThan(0);
      // 独立证据：打开备份文件本身读行数，而不是「文件存在就算过」
      expect(sqlite(result.filePath, 'SELECT id FROM meals ORDER BY id;')).toBe('1\n2\n3');
    });
  });

  it('同一天跑两次只留一份，且第二份是更新的快照', () => {
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (1, "餐-1");');
    const first = runBackup({ dbPath, root, today: '2026-09-20', keep: 7 });
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (2, "餐-2");');
    const second = runBackup({ dbPath, root, today: '2026-09-20', keep: 7 });

    expect(first.fileName).toBe(second.fileName);
    expect(fs.readdirSync(backupsDir(root))).toEqual(['dinner-2026-09-20.db']);
    expect(sqlite(second.filePath, 'SELECT id FROM meals ORDER BY id;')).toBe('1\n2');
  });

  it('按日滚动：连跑四天、上限 3，最旧那份被删掉', () => {
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (1, "餐-1");');
    const prunedByDay = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].map(
      (today) => runBackup({ dbPath, root, today, keep: 3 }).pruned,
    );

    // 没超上限时一份都不删，越过上限后每天恰好删掉当时最旧的那一份
    expect(prunedByDay).toEqual([[], [], [], ['2026-09-17']]);
    const next = runBackup({ dbPath, root, today: '2026-09-21', keep: 3 });
    expect(next.pruned).toEqual(['2026-09-18']);
    expect(listBackups(root).map((entry) => entry.date)).toEqual(['2026-09-21', '2026-09-20', '2026-09-19']);
  });

  it('备份是**冷藏快照**：journal_mode 已复位，打开它不会在备份目录里留下 -wal/-shm', () => {
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (1, "餐-1");');
    const result = runBackup({ dbPath, root, today: '2026-09-20', keep: 7 });

    // 源库是 WAL，`.backup` 会把 WAL 一起带过去；不主动复位的话，任何人打开备份
    // （包括本次恢复演练）都会在 backups/ 里留下两个侧文件——而它们不匹配备份命名形状，
    // 滚动保留不会清，日子一长就堆成垃圾
    expect(sqlite(result.filePath, 'PRAGMA journal_mode;')).toBe('delete');

    // 真的打开一次（读一下行），然后断言目录里只有那份备份
    expect(sqlite(result.filePath, 'SELECT count(*) FROM meals;')).toBe('1');
    expect(fs.readdirSync(backupsDir(root))).toEqual(['dinner-2026-09-20.db']);
  });

  it('滚动删日期时连同侧文件一起清（否则删了 .db 却留下孤儿侧文件）', () => {
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (1, "餐-1");');
    const old = runBackup({ dbPath, root, today: '2026-09-17', keep: 7 });
    // 手工造出侧文件（模拟「有人打开过它」——WAL 之外任何工具都可能这么干）
    fs.writeFileSync(`${old.filePath}-wal`, '');
    fs.writeFileSync(`${old.filePath}-shm`, '');

    runBackup({ dbPath, root, today: '2026-09-20', keep: 1 });

    expect(fs.existsSync(old.filePath)).toBe(false);
    expect(fs.existsSync(`${old.filePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${old.filePath}-shm`)).toBe(false);
  });

  it('认不出的文件不参与滚动，也不被删', () => {
    sqlite(dbPath, 'INSERT INTO meals (id, name) VALUES (1, "餐-1");');
    const foreign = path.join(backupsDir(root), '我的手工备份.db');
    fs.mkdirSync(backupsDir(root), { recursive: true });
    fs.writeFileSync(foreign, '不是我写的');

    for (const today of ['2026-09-19', '2026-09-20']) {
      runBackup({ dbPath, root, today, keep: 1 });
    }

    expect(fs.existsSync(foreign)).toBe(true);
    expect(listBackups(root).map((entry) => entry.fileName)).toEqual(['dinner-2026-09-20.db']);
  });

  it('源库不存在就报错，不留下一个「看着成功」的空备份', () => {
    expect(() => runBackup({ dbPath: path.join(root, '不存在.db'), root, today: '2026-09-20', keep: 7 })).toThrow();
    expect(listBackups(root)).toEqual([]);
  });
});
