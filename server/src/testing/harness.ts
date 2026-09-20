import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import type { AppOptions } from '../app.js';
import { createApp } from '../app.js';
import type { Clock } from '../clock.js';
import { normalizeBasePath } from '../config.js';
import { closeDatabase, openDatabase, type Db } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createFakeLlmClient, type FakeLlmClient } from '../llm/fake.js';
import type { ToolDefinition } from '../llm/types.js';

export interface TestClock extends Clock {
  /** 拨动时钟（测试里模拟「现在」流逝，验证去重窗口/餐槽判定用） */
  set(instant: Date | string | number): void;
  advance(ms: number): void;
}

/** 可控时钟：起点固定，测试自己决定「现在」 */
export function createTestClock(start: Date | string | number = '2025-06-01T10:00:00.000Z'): TestClock {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(instant) {
      current = new Date(instant);
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

export interface TestHarnessOptions {
  basePath?: string;
  /** 覆盖迁移目录（缺省用仓库内 server/migrations，通常为空） */
  migrationsDir?: string;
  /** 预置的 LLM 工具（形状按 MCP） */
  llmTools?: ToolDefinition[];
  /** 需要端到端验证静态产物注入时传入（一般测试不传） */
  webDistDir?: string;
}

export interface TestHarness {
  app: Hono;
  db: Db;
  llm: FakeLlmClient;
  clock: TestClock;
  basePath: string;
  /** 进程内直打 HTTP：不必起监听端口，也不关心端口冲突 */
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  close(): void;
}

/**
 * 造一位「只忌这几味」的家人（走**真 HTTP 路径**，不是手写 INSERT）。
 *
 * 为什么要这个 helper：忌口传播的测试要反复建「新的人 + 他的忌口」（#28 一次就加了四条），
 * 手写 `INSERT INTO members ...` 既长又容易把列写漏（而且那条 SQL 不走领域层的校验）。
 * 走 `POST /api/members` + `PATCH /api/members/:id` 的话，建出来的家人与真实使用完全同形
 * （sort_order 由领域层排、created_at 用注入时钟），断言就只针对被测行为本身。
 */
export async function seedAvoider(
  harness: TestHarness,
  options: { name: string; emoji?: string; gender?: 'male' | 'female'; avoid: string[] },
): Promise<string> {
  const created = await harness.json<{ member?: { id: string }; error?: string }>('/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: options.name,
      emoji: options.emoji ?? '🙅',
      kind: 'adult',
      gender: options.gender ?? 'female',
    }),
  });
  if (created.status !== 201 || !created.body.member) {
    throw new Error(`造家人失败（${created.status}）：${JSON.stringify(created.body)}`);
  }
  const id = created.body.member.id;

  const patched = await harness.json<{ member?: unknown; error?: string; ingredientId?: string }>(
    `/api/members/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avoid: options.avoid }),
    },
  );
  if (patched.status !== 200) {
    // 忌口条目要指向真食材（字典是唯一受控表）；写错 id 时错误体里会带 ingredientId
    throw new Error(`设忌口失败（${patched.status}）：${JSON.stringify(patched.body)}`);
  }
  return id;
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * 后续所有工单的集成测试入口：内存 SQLite（每个 harness 全新实例 → 测试间零共享状态）、
 * 注入的 fake LLM、可控时钟、任意 basePath。
 */
export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const basePath = normalizeBasePath(options.basePath ?? '/');
  const db = openDatabase(':memory:');
  runMigrations(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  const llm = createFakeLlmClient(options.llmTools ?? []);
  const clock = createTestClock();

  const appOptions: AppOptions = { db, clock, llm, basePath, webDistDir: options.webDistDir };
  const app = createApp(appOptions);

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = path.startsWith('http') ? path : `http://localhost${path.startsWith('/') ? path : `/${path}`}`;
    // Hono 的 app.request 在类型上可能是同步返回，统一 await 成 Promise
    return await app.request(url, init);
  };

  return {
    app,
    db,
    llm,
    clock,
    basePath,
    request,
    async json<T>(path: string, init?: RequestInit) {
      const response = await request(path, init);
      const text = await response.text();
      return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
    },
    close() {
      closeDatabase(db);
    },
  };
}
