/**
 * 冷启动导入 CLI（总纲 §2.8、§5；ADR-0006）。
 *
 * 为什么是脚本而不是 API 路由：导入是**离线批处理**（跑一次把外部池打底到 150–300 道），
 * 不是产品里的动作。放进 HTTP 只会多一条能被误触的写库入口。
 *
 * 三个模式（仓库根执行，`pnpm --filter @dinnerorder/server run import:library <参数>`）：
 *
 *   1. **采集成快照**（碰本地文件，不碰网）：`--collect-htc <HowToCook 的 dishes 目录> --snapshot <file>`
 *      把「采集 + 筛选」的结果写成 JSONL 存进仓库（`server/library-data/`）。这样**导入是可复现的**：
 *      同一份快照反复导入得到同一批草稿，不依赖「今天 GitHub 能不能连上」。
 *      取数本身是有界的两条命令（见 README 的导入一节）。
 *   2. **导入**（缺省模式）：`--from <快照 JSONL> [--xcf-dir <抓下来的热榜 HTML 目录>] [--llm]`
 *      → 归一 → 落库为草稿 → LLM 重标与菜系初打（`--llm` 时）→ 报告。
 *   3. **只看不写**：加 `--dry-run`（报告照出，用来先确认「会导多少、有多少归不上」）。
 *      加 `--replace` 则刷新已有草稿（补了字典别名之后重跑用；家庭菜谱永不覆盖）。
 *
 * **绝不打印 .env 内容**：脚本只经 `createLlmClient` 读环境变量，不 echo。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../src/config.js';
import { ensureParentDir, openDatabase, closeDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLlmClient } from '../src/bootstrap.js';
import { createFakeLlmClient } from '../src/llm/fake.js';
import {
  buildReport,
  importDrafts,
  loadIngredientIndex,
  normalizeRecipe,
  relabelDrafts,
  tagDraftCuisines,
  writeReport,
  type DraftRecipe,
  type NormalizedRecipe,
  type RejectedRecipe,
} from '../src/domain/library.js';
import { parseHowToCook, xiachufangDraft } from '../src/library/collectors.js';

interface Options {
  collectHtc?: string;
  from?: string;
  snapshot?: string;
  xcfDir?: string;
  useLlm: boolean;
  dryRun: boolean;
  replace: boolean;
  reportPath: string;
  dbPath: string;
  limit?: number;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      'collect-htc': { type: 'string' },
      from: { type: 'string' },
      snapshot: { type: 'string' },
      'xcf-dir': { type: 'string' },
      llm: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      report: { type: 'string' },
      db: { type: 'string' },
      limit: { type: 'string' },
    },
    allowPositionals: false,
  });

  return {
    collectHtc: values['collect-htc'],
    // 相对路径一律相对**仓库根**解析（不是 cwd）：脚本常从 server/ 下被 pnpm 唤起，
    // 用 cwd 会让 `--snapshot server/library-data/x.jsonl` 落成 `server/server/...`。
    from: values.from === undefined ? undefined : resolveFromRoot(values.from),
    snapshot: values.snapshot === undefined ? undefined : resolveFromRoot(values.snapshot),
    xcfDir: values['xcf-dir'] === undefined ? undefined : resolveFromRoot(values['xcf-dir']),
    useLlm: values.llm ?? false,
    dryRun: values['dry-run'] ?? false,
    replace: values.replace ?? false,
    reportPath: resolveFromRoot(values.report, 'data/import-report.json'),
    dbPath: resolveFromRoot(values.db, 'data/dinner.db'),
    limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const generatedAt = new Date().toISOString();
  const notes: string[] = [];

  // —— 模式一：只采集成快照（碰本地文件，不碰网；导入的输入就是它）
  if (options.collectHtc) {
    if (!options.snapshot) {
      console.error('--collect-htc 必须配 --snapshot <输出文件>');
      process.exitCode = 1;
      return;
    }
    const files = listMarkdown(options.collectHtc);
    const drafts: DraftRecipe[] = [];
    const skippedFiles: { path: string; reason: string }[] = [];
    for (const file of files) {
      const relative = path.relative(options.collectHtc, file).replace(/\\/g, '/');
      const draft = parseHowToCook(`dishes/${relative}`, fs.readFileSync(file, 'utf8'));
      if (draft) drafts.push(draft);
      else
        skippedFiles.push({
          path: relative,
          reason: '「家常热度 + 忌口排除」筛选口径：非家常目录 / 非家常类 / 命中忌口粗筛 / 缺份量段',
        });
    }
    ensureParentDir(options.snapshot);
    // 快照按 id 去重：HowToCook 里存在「同名菜两种目录形状」的目录（`soup/陈皮排骨汤.md`
    // 与 `soup/陈皮排骨汤/陈皮排骨汤.md`），两个路径的菜名一样 → `draftId` 一样。
    // 不去重的话快照里就会有两行同 id，导入时后一行必被拒为「同 id 的草稿已存在」——
    // 那是快照自相矛盾，不是导入器的问题。去重只认 id（同一个 id 就是同一道菜）。
    const seenIds = new Set<string>();
    const unique = drafts.filter((draft) => {
      if (seenIds.has(draft.id)) return false;
      seenIds.add(draft.id);
      return true;
    });
    fs.writeFileSync(options.snapshot, `${unique.map((draft) => JSON.stringify(draft)).join('\n')}\n`, 'utf8');
    console.log(`采集 ${unique.length}/${files.length} 篇 → ${options.snapshot}`);
    if (unique.length !== drafts.length) console.log(`按 id 去重 ${drafts.length - unique.length} 条（同一道菜被两种目录形状采了两次）`);
    console.log(`按筛选口径跳过 ${skippedFiles.length} 篇（采集模式只写快照、不写报告，故只报数不留清单；筛选口径见 parseHowToCook，逐条清单走导入模式的报告）`);
    return;
  }

  // —— 模式二/三：导入（输入是快照 + 可选的下厨房 HTML 目录）
  const collected: DraftRecipe[] = [];
  const skipped: RejectedRecipe[] = [];
  if (options.from) {
    const lines = fs
      .readFileSync(options.from, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    for (const line of lines) collected.push(JSON.parse(line) as DraftRecipe);
    notes.push(`快照 ${path.basename(options.from)}：${collected.length} 道`);
  }
  if (options.xcfDir) {
    // manifest.json 是下厨房那条路的**真 URL 来源**（`fetch-xiachufang.ts` 写的）。
    // 不能从文件名序号拼一个 `https://www.xiachufang.com/recipe/<序号>/`：那不是页面地址，
    // 而 `sourceRef` 要如实（AC），并且它还当选草稿 id 的 key。没有 manifest 就如实降级。
    let listing: XiachufangListing;
    try {
      listing = listXiachufangEntries(options.xcfDir);
    } catch (error) {
      notes.push(
        `下厨房这条路不可用：${error instanceof Error ? error.message : String(error)}——` +
          '本批只导 HowToCook 那一路（不从文件名猜 URL）。',
      );
      listing = { entries: [], missing: [] };
    }
    for (const file of listing.missing) {
      skipped.push({
        id: file,
        name: file,
        source: 'scraped',
        sourceRef: file,
        reason: 'manifest.json 里登记了这个文件，但目录里找不到它（取数那步没写全？）',
      });
    }
    let parsed = 0;
    for (const entry of listing.entries) {
      const draft = xiachufangDraft({ name: entry.name, url: entry.url }, fs.readFileSync(entry.file, 'utf8'));
      if (draft) {
        collected.push(draft);
        parsed += 1;
      } else {
        skipped.push({
          id: entry.url,
          name: entry.name,
          source: 'scraped',
          sourceRef: entry.url,
          reason: '详情页里没解析出原料表（页面结构变了或是跳到别的页）',
        });
      }
    }
    notes.push(`下厨房：manifest 登记 ${listing.entries.length} 条，解析出原料表 ${parsed} 道（来源标 scraped）`);
  }
  if (collected.length === 0) {
    console.error('没有采到任何菜：检查 --from / --xcf-dir 指向的目录（或先跑 --collect-htc 生成快照）。');
    process.exitCode = 1;
    return;
  }

  ensureParentDir(options.dbPath);
  const db = openDatabase(options.dbPath);
  try {
    runMigrations(db, path.join(REPO_ROOT, 'server', 'migrations'));

    // 归一（对字典；字典是全库唯一受控表，对不上就进报告，不新建字典行）
    const index = loadIngredientIndex(db);
    const normalized: NormalizedRecipe[] = [];
    for (const draft of collected) {
      try {
        const { normalized: recipe } = normalizeRecipe(index, draft);
        normalized.push(recipe);
      } catch (error) {
        skipped.push({
          id: draft.id,
          name: draft.name,
          source: draft.source,
          sourceRef: draft.sourceRef,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (options.limit !== undefined) normalized.splice(options.limit);

    const llm = options.useLlm ? createLlmClient(process.env, REPO_ROOT) : createFakeLlmClient();
    if (!options.useLlm) notes.push('未开 --llm：份量全部留「待重标」（报告里 relabel.pending），菜系只落采集侧能确定的那些');

    const outcome = importDrafts(db, {
      recipes: normalized,
      dryRun: options.dryRun,
      // --replace：把同名/同 id 的**草稿**清掉重写。用途只有一个——补了字典别名/改了筛选口径
      // 之后要把已有草稿刷新一遍（草稿还没有历史与转正版本，重写无损）。
      // **家庭菜谱永不覆盖**（importDrafts 里对非草稿状态直接拒）。
      onConflict: options.replace ? 'replace' : 'skip',
      notes,
    });
    outcome.rejected.push(...skipped);

    let relabel = { requests: 0, written: 0, calls: 0, notes: [] as string[] };
    let cuisine = { requests: 0, written: 0, calls: 0, notes: [] as string[] };
    if (options.useLlm && !options.dryRun) {
      relabel = await relabelDrafts(db, llm);
      cuisine = await tagDraftCuisines(db, llm);
      outcome.notes.push(
        `LLM 重标：${relabel.written} 项写回（${relabel.calls} 次调用）；菜系初打：草稿 ${cuisine.written} 道带 tag（${cuisine.calls} 次调用）`,
        ...relabel.notes,
        ...cuisine.notes,
      );
    }

    const report = buildReport(db, outcome, { generatedAt });
    writeReport(report, options.reportPath);

    // 覆盖率用**报告里那份**（dry-run 时它带的是事务内的数字；回滚后再查库读到的是导入前状态）
    const coverage = report.relabel;
    console.log('—— 冷启动导入报告 ——');
    console.log(`本次落库草稿：${report.imported.length} 道（dry-run=${options.dryRun}）`);
    console.log(`跳过/被拒：${report.rejected.length} 条（见报告的 rejected 清单）`);
    console.log(`归一失败：${report.unmatched.length} 条（见报告的 unmatched 清单）`);
    console.log(
      `份量重标：${coverage.done}/${coverage.needed}（覆盖率 ${(coverage.coverage * 100).toFixed(1)}%），待重标 ${coverage.pending.length} 项`,
    );
    console.log(`时令手工表：${report.season.ingredients} 种食材 × ${report.season.months} 个月`);
    console.log(`报告已写：${options.reportPath}`);
  } finally {
    closeDatabase(db);
  }
}

/** 相对路径相对仓库根解析（缺省值同样从这里走），见 Options 处的说明 */
function resolveFromRoot(value: string | undefined, fallback?: string): string {
  const raw = value ?? fallback;
  if (raw === undefined) throw new Error('路径缺失');
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw);
}

/** 递归列出 markdown（有界：只认 .md，深目录也只是 HowToCook 的四层） */
function listMarkdown(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.md') && !/readme/i.test(entry.name)) files.push(full);
    }
  }
  return files.sort();
}

/**
 * 下厨房那条路的落盘约定（由 `scripts/fetch-xiachufang.ts` 写）：`<dir>/manifest.json`，
 * 形如 `{fetchedAt, source, entries:[{name, url, file}]}`——`url` 是**详情页的真实地址**，
 * `file` 是它在同一个目录里的落盘名。导入侧只信它：真 URL 拿不到就不导，
 * **不从文件名序号猜一个看起来像的 URL**（来源字段如实是 AC，猜出来的 URL 还当选草稿 id）。
 *
 * 缺 manifest / 形状不对一律抛（调用方降级成「这条腿不可用」），坏在明处比编造好。
 */
export interface XiachufangListing {
  entries: { name: string; url: string; file: string }[];
  /** manifest 登记了、但目录里没有的落盘名（如实降级，不静默） */
  missing: string[];
}

export function listXiachufangEntries(root: string): XiachufangListing {
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${manifestPath} 不存在（下厨房的抓取产物必须有 manifest.json；旧版本的文件名约定没有 URL，不能当来源用）`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error(`${manifestPath} 形状不对：缺少 entries 数组`);

  const entries: { name: string; url: string; file: string }[] = [];
  const missing: string[] = [];
  for (const raw of parsed.entries as { name?: unknown; url?: unknown; file?: unknown }[]) {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    const url = typeof raw?.url === 'string' ? raw.url : '';
    const file = typeof raw?.file === 'string' ? raw.file : '';
    if (name === '' || url === '' || file === '') {
      throw new Error(`${manifestPath} 的条目形状不对（需要 name/url/file）：${JSON.stringify(raw)}`);
    }
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) {
      missing.push(file);
      continue;
    }
    entries.push({ name, url, file: fullPath });
  }
  return { entries, missing };
}

// 直接执行时跑 CLI；被测试 import 时只取上面的辅助函数，不执行 CLI。
// 这是 `process.argv[1]`（入口路径）与 `import.meta.url` 的常规对照。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
