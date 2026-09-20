/**
 * 每日热备的生产入口：`node server/dist/deploy/backup-cli-entry.js`（由 launchd 的定时 LaunchAgent 唤起）。
 *
 * 与 `src/index.ts` 同一路数：**跑编译产物，不依赖 tsx**。热备要能在「仓库还没装 devDependencies」
 * 或「devDependencies 被清了」的机器上照常跑——launchd 每天叫它一次，那时没人在旁边看报错。
 * 所以逻辑在 `src/deploy/backup-cli.ts`（可单测），这里只管进程边界。
 *
 * 设计取向：**静默成功、响亮失败**。成功时不该往日志里灌噪音；失败必须非零退出
 * （plist 的 StandardErrorPath 会留下现场），否则「备份悄悄没跑」会一直没人发现——直到需要恢复那天。
 */
import { executeBackup, parseOptions } from './backup-cli.js';

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const result = executeBackup(options);

  if (options.json) {
    // 结构化回执：测试与人工排查都读它（launchd 日志里也看得懂）
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  // 缺省静默：没滚动删除就不吭声（每天一行噪音会让人不再看日志）
  if (result.pruned.length > 0) {
    console.log(`[backup] ${result.fileName}（${result.bytes} 字节），滚动删除：${result.pruned.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backup] 失败：${message}`);
  // 磁盘满 / 库被独占 / 源库不存在——都该让人看见现场
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
