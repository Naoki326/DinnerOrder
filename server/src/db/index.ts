import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * 打开数据库。`:memory:` 用于测试（每个 harness 一个全新实例，天然隔离）；
 * 文件路径用于生产。
 */
export function openDatabase(filename: string): Db {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  // 生产是单进程单连接，但仍给足忙等时间，避免外部 sqlite3 CLI（热备）抢锁时报错
  db.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function closeDatabase(db: Db): void {
  if (db.open) db.close();
}

export function ensureParentDir(filePath: string): void {
  if (filePath === ':memory:') return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
