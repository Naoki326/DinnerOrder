/**
 * 下厨房热榜的**有界**取数（spec §2.8：「只轻量抓家常热榜或用现成小数据集，不搞全站爬」）。
 *
 * 与 `import-library.ts` 分开的理由：导入器必须是**纯离线**的（无网络也能重跑、失败可复现，
 * 测试也只吃本地 fixture），取数是唯一碰网络的一步。两者之间用**文件系统**对接：
 *
 *   fetch-xiachufang.ts  →  <dir>/<rank>-<cleanName>.html  +  <dir>/manifest.json
 *   import-library.ts    ←  --xcf-dir <dir>
 *
 * 有界是硬要求（无开放许可，自家私用、风险自知接受——ADR-0006）：
 *   * 只抓**热榜页自己列出的**条目，默认最多 12 条（`--top`）；
 *   * 每次请求 `AbortSignal.timeout(15_000)`，两次请求之间 `--delay`（默认 1.2s）不连击；
 *   * 热榜页抓不到就**如实降级**：不重试、不换镜像、不引入 headless 浏览器，退出码 1 +
 *     一句人话，报告与导入回到「只有 HowToCook」那条路。
 *
 * 用法（仓库根）：
 *   pnpm --filter @dinnerorder/server run fetch:xiachufang --out data/xiachufang --top 12
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../src/config.js';
import { parseXiachufangHtml, slugOf } from '../src/library/collectors.js';

const EXPLORE_URL = 'https://www.xiachufang.com/explore/';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function parseOptions(): { outDir: string; top: number; delayMs: number; timeoutMs: number } {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'data/xiachufang' },
      top: { type: 'string', default: '12' },
      delay: { type: 'string', default: '1200' },
      timeout: { type: 'string', default: '15000' },
    },
    allowPositionals: false,
  });
  return {
    // 相对路径一律相对**仓库根**（与 import-library.ts 同一口径，见那个文件里的说明）
    outDir: path.isAbsolute(values.out!) ? values.out! : path.join(REPO_ROOT, values.out!),
    top: Number.parseInt(values.top!, 10),
    delayMs: Number.parseInt(values.delay!, 10),
    timeoutMs: Number.parseInt(values.timeout!, 10),
  };
}

/** 一次有界 GET：超时算失败（不重试——重试就要再等 15s，而且对站点不礼貌） */
async function get(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.error(`取数失败：${url} → HTTP ${response.status}`);
      return undefined;
    }
    return await response.text();
  } catch (error) {
    // 超时/断网/被拒都走这里：**不重试**，如实降级（降级说明进 stderr 与 manifest）
    console.error(`取数失败：${url} → ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  fs.mkdirSync(options.outDir, { recursive: true });

  const listing = await get(EXPLORE_URL, options.timeoutMs);
  if (listing === undefined) {
    console.error('热榜页取不到：本次跳过爬取（HowToCook 那条路不受影响；见 docs/agents/open-items.md 的降级口径）');
    process.exitCode = 1;
    return;
  }

  const entries = parseXiachufangHtml(listing).slice(0, options.top);
  if (entries.length === 0) {
    console.error('热榜页取到了但没解析出任何菜（页面结构变了）——本次跳过爬取');
    process.exitCode = 1;
    return;
  }

  const manifest: { name: string; url: string; file: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    const file = `${String(index + 1).padStart(2, '0')}-${slugOf(entry.name)}.html`;
    const target = path.join(options.outDir, file);
    const html = await get(entry.url, options.timeoutMs);
    if (html === undefined) continue;
    fs.writeFileSync(target, html, 'utf8');
    manifest.push({ name: entry.name, url: entry.url, file });
    console.log(`✓ ${entry.name}`);
    if (index < entries.length - 1) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }

  fs.writeFileSync(
    path.join(options.outDir, 'manifest.json'),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), source: EXPLORE_URL, entries: manifest }, null, 2)}\n`,
    'utf8',
  );
  console.log(`取到 ${manifest.length} 条 → ${options.outDir}（manifest.json 记录了菜名与 URL）`);
  if (manifest.length === 0) process.exitCode = 1;
}

await main();
