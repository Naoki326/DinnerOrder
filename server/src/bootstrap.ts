import path from 'node:path';
import { createApp } from './app.js';
import { systemClock, type Clock } from './clock.js';
import { loadServerConfig, REPO_ROOT, type ServerConfig } from './config.js';
import { ensureParentDir, openDatabase, type Db } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createOpenAiLlmClient } from './llm/openai.js';
import { createUnconfiguredLlmClient } from './llm/unconfigured.js';
import type { LlmClient } from './llm/types.js';

/**
 * 「把一台服务器拉起来」的最小装配（生产入口与 E2E 服务端共用）。
 *
 * 抽出来的是两步：**建库 + 跑迁移** 和 **选 LLM 客户端**。开发入口（dev.ts）刻意不用它——
 * 那里不服务静态产物、端口与库路径也不同，硬套共享反而要把差异都变成参数。
 *
 * LLM 的选择规则（一处，不两边各写一遍）：
 *   * 缺 key/baseURL → `createUnconfiguredLlmClient()`：推荐走简化推荐，其余功能照常。
 *     **不启动即崩**：家里没配 LLM 时，手动挑菜这条主路必须还能用。
 *   * 都齐 → 真实 `openai` 客户端（`maxRetries:0`，重试在编排层）。
 *   * `DEBUG=1` → 请求/响应落 `data/logs/`（spec §4；目录随 .env 一起被备份排除）。
 */
export function createLlmClient(env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): LlmClient {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? '';
  const baseUrl = env.OPENAI_BASE_URL?.trim() ?? '';
  if (apiKey === '' || baseUrl === '') return createUnconfiguredLlmClient();

  return createOpenAiLlmClient({
    apiKey,
    baseUrl,
    model: env.LLM_MODEL?.trim() || 'qwen3.8-flash',
    debugLogDir: env.DEBUG === '1' ? path.resolve(root, 'data/logs') : undefined,
  });
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * 仓库根（默认 `REPO_ROOT`——从模块自身定位，不取 cwd）。
   * 这点很重要：launchd 拉起进程时 cwd 可能是 `/` 或家目录，
   * 用 cwd 会让 `data/dinner.db` 落在意想不到的地方。
   */
  root?: string;
  /** 覆盖 config（入口想改端口/库路径时用） */
  config?: Partial<ServerConfig>;
  /**
   * 直接注入 LLM 客户端（跳过环境变量那套）。
   * 给 E2E 的单进程服务端用：那里要的是一个**确定性**的 fake（不联网、不随模型变），
   * 而生产入口走 `createLlmClient(env)`；两者的其余装配（库/迁移/静态产物）完全一样。
   */
  llm?: LlmClient;
  /**
   * 注入时钟（缺省 `systemClock`）。生产入口不传——只有 E2E 服务端需要一个可拨动的时钟
   * （`E2E_CLOCK_CONTROL=1` 时它经 `PUT /api/e2e/clock` 调）。
   * 这个 seam 与测试 harness 的 `createTestClock()` 是同一件事，只是隔着一条 HTTP 通道。
   */
  clock?: Clock;
}

export interface Bootstrapped {
  config: ServerConfig;
  db: Db;
  llm: LlmClient;
  app: ReturnType<typeof createApp>;
  /** 本次启动应用了哪些迁移（入口负责打印） */
  applied: string[];
  alreadyApplied: number;
}

export function bootstrap(options: BootstrapOptions = {}): Bootstrapped {
  const env = options.env ?? process.env;
  const root = options.root ?? REPO_ROOT;
  const config = { ...loadServerConfig(env, root), ...options.config };

  ensureParentDir(config.dbPath);
  const db = openDatabase(config.dbPath);
  const { applied, alreadyApplied } = runMigrations(db, config.migrationsDir);

  const llm = options.llm ?? createLlmClient(env, root);
  const clock = options.clock ?? systemClock;
  const app = createApp({ db, clock, llm, basePath: config.basePath, webDistDir: config.webDistDir });

  return { config, db, llm, app, applied: applied.map((migration) => migration.version), alreadyApplied: alreadyApplied.length };
}
