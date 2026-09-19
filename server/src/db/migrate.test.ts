import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from './index.js';
import { listMigrations, runMigrations } from './migrate.js';

let tmpDir: string;
let db: Db;

function writeMigration(name: string, sql: string): void {
  fs.writeFileSync(path.join(tmpDir, name), sql, 'utf8');
}

function appliedVersions(database: Db): string[] {
  return database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => (row as { version: string }).version);
}

function tableNames(database: Db): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-migrations-'));
  db = openDatabase(':memory:');
});

afterEach(() => {
  closeDatabase(db);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('listMigrations', () => {
  it('按版本号升序排列，忽略非 .sql 文件', () => {
    writeMigration('010_later.sql', 'CREATE TABLE b (id INTEGER);');
    writeMigration('002_earlier.sql', 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '说明', 'utf8');

    expect(listMigrations(tmpDir).map((m) => m.version)).toEqual(['002', '010']);
    expect(listMigrations(tmpDir).map((m) => m.name)).toEqual(['earlier', 'later']);
  });

  it('目录不存在、文件名不合约定、版本号重复都抛错', () => {
    expect(() => listMigrations(path.join(tmpDir, 'missing'))).toThrow(/不存在/);

    writeMigration('bad-name.sql', 'SELECT 1;');
    expect(() => listMigrations(tmpDir)).toThrow(/不符合/);
    fs.rmSync(path.join(tmpDir, 'bad-name.sql'));

    writeMigration('001_a.sql', 'SELECT 1;');
    writeMigration('001_b.sql', 'SELECT 1;');
    expect(() => listMigrations(tmpDir)).toThrow(/重复/);
  });

  /**
   * 仓库自带的迁移目录必须**无重复版本号**且能整体跑起来。
   *
   * 上面那条验的是执行器的行为，用的是临时 fixture；这一条验的是**实际随库的那份目录**：
   * 并行开发的多个票各自新增迁移时，撞号是最容易发生、也最贵的一种集成故障
   * （`runMigrations` 会直接抛「版本号重复」，应用启动即失败）。
   */
  it('仓库 migrations 目录无版本号重复，且能按序全部执行', () => {
    const repoMigrations = fileURLToPath(new URL('../../migrations', import.meta.url));

    const versions = listMigrations(repoMigrations).map((m) => m.version);
    expect(versions.length).toBeGreaterThan(0);
    // 升序且无重复（重复会让 listMigrations 先抛错，这里显式钉住「无重复」这条不变量）
    expect(versions).toEqual([...new Set(versions)].sort());

    const result = runMigrations(db, repoMigrations);
    expect(result.applied.map((m) => m.version)).toEqual(versions);
    expect(appliedVersions(db)).toEqual(versions);
    // 家人软删除那一列确实由迁移落的（本票改号后仍要真的执行到）
    const columns = db.prepare('PRAGMA table_info(members)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain('deleted_at');
  });
});

describe('runMigrations', () => {
  it('第一次全跑，第二次幂等（不重复执行、不重复记账）', () => {
    writeMigration('001_first.sql', 'CREATE TABLE first_t (id INTEGER PRIMARY KEY);');
    writeMigration('002_second.sql', 'CREATE TABLE second_t (id INTEGER);');

    const first = runMigrations(db, tmpDir);
    expect(first.applied.map((m) => m.version)).toEqual(['001', '002']);
    expect(first.alreadyApplied).toEqual([]);
    expect(tableNames(db)).toEqual(['first_t', 'schema_migrations', 'second_t']);

    const second = runMigrations(db, tmpDir);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['001', '002']);
  });

  it('只执行新增的迁移，已应用的版本跳过', () => {
    writeMigration('001_first.sql', 'CREATE TABLE first_t (id INTEGER);');
    runMigrations(db, tmpDir);

    writeMigration('002_second.sql', 'CREATE TABLE second_t (id INTEGER);');
    const result = runMigrations(db, tmpDir);

    expect(result.applied.map((m) => m.version)).toEqual(['002']);
    expect(result.alreadyApplied).toEqual(['001']);
  });

  it('失败的迁移整体回滚，且不记账——下次启动可重试', () => {
    writeMigration('001_ok.sql', 'CREATE TABLE ok_t (id INTEGER);');
    writeMigration('002_broken.sql', 'CREATE TABLE will_rollback (id INTEGER); SELECT * FROM nowhere;');

    expect(() => runMigrations(db, tmpDir)).toThrow();

    expect(tableNames(db)).not.toContain('will_rollback');
    expect(appliedVersions(db)).toEqual(['001']);

    // 修好后重跑：001 跳过，002 补上
    writeMigration('002_broken.sql', 'CREATE TABLE fixed_t (id INTEGER);');
    const retry = runMigrations(db, tmpDir);
    expect(retry.applied.map((m) => m.version)).toEqual(['002']);
    expect(tableNames(db)).toContain('fixed_t');
  });

  it('迁移执行器自身不依赖仓库 migrations 目录内容（空目录也能跑）', () => {
    const result = runMigrations(db, tmpDir);
    expect(result.applied).toEqual([]);
    expect(tableNames(db)).toEqual(['schema_migrations']);
  });
});
