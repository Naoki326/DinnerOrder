import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';

const MIGRATION_FILE_PATTERN = /^(\d{3,})[_-](.+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
}

export interface MigrationResult {
  applied: MigrationFile[];
  /** 本次启动前就已应用过的版本号 */
  alreadyApplied: string[];
}

/**
 * 读取迁移目录并按版本号升序排列。
 * 文件名形如 `001_init.sql`（前缀数字即版本号），目录缺失视为配置错误而非「无迁移」。
 */
export function listMigrations(migrationsDir: string): MigrationFile[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`迁移目录不存在：${migrationsDir}`);
  }
  const entries = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const migrations = entries.map((name) => {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match) {
      throw new Error(`迁移文件名不符合 <版本号>_<描述>.sql 约定：${name}`);
    }
    return { version: match[1]!, name: match[2]!, filePath: path.join(migrationsDir, name) };
  });

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`迁移版本号重复：${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/**
 * ~40 行迁移执行器（ADR-0002）：编号 .sql 按序执行，已执行的记在 schema_migrations，
 * 每个文件一个事务——失败即回滚，下次启动从同一个版本重试，不会留下半截 schema。
 */
export function runMigrations(db: Db, migrationsDir: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const migrations = listMigrations(migrationsDir);
  const done = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: string }).version),
  );
  const alreadyApplied = migrations.filter((m) => done.has(m.version)).map((m) => m.version);
  const pending = migrations.filter((m) => !done.has(m.version));

  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const applied: MigrationFile[] = [];

  for (const migration of pending) {
    const sql = fs.readFileSync(migration.filePath, 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    applied.push(migration);
  }

  return { applied, alreadyApplied };
}
