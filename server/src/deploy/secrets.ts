/**
 * 密钥与调试数据的边界（spec §4/§7、AC：`.env` chmod 600 且排除出双备份通道）。
 *
 * 三条边界，三条都在这里实现（**一处**，不散在文档里）：
 *
 * 1. **`.env` 权限必须是 600**：里面是 LLM key。`chmod 600` 是 spec 的原文要求，
 *    而「安装脚本顺手做一次」比「文档里写一句请记得」可靠得多——所以 `install` 会校正它。
 * 2. **Time Machine 排除**：`.env` 与 `data/logs/`（DEBUG=1 时的完整请求/响应，
 *    可能含用户输入与菜谱正文）都不进整机备份。
 * 3. **热备排除**：热备只备**数据库文件**，天然不含 `.env` 与 `data/logs/`——
 *    但这句话需要被钉住，否则日后有人「顺手把整个仓库 tar 一份当备份」就漏了。
 *    `deploy/tm-exclusions.txt` 是这份清单的落地形态，给 `tmutil addexclusion` 与人工核对用。
 *
 * 为什么用 `tmutil addexclusion` 而不是在 `.env` 上放 `com.apple.metadata:com_apple_backup_excludeItem`
 * 扩展属性：`tmutil` 是 Apple 支持的入口（`tmutil isexcluded` 能立刻查回来），
 * 而扩展属性会在文件被重写（换 key）时丢失——那是最不该静默失效的地方。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.js';

export interface SecretPath {
  /** 相对仓库根的展示路径（报告里用） */
  relative: string;
  /** 绝对路径 */
  absolute: string;
  /** 为什么排除它（写进清单文件，让人知道别手贱加回去） */
  reason: string;
}

/** `.env` 的权限位（spec §4 原文：chmod 600） */
export const ENV_MODE = 0o600;

/** 需要排除出**两条备份通道**的路径（spec §4 点名的就是这两处，不多不少） */
export function secretPaths(root: string): SecretPath[] {
  return [
    {
      relative: '.env',
      absolute: path.join(root, '.env'),
      reason: 'LLM API key（spec §4：排除出 Time Machine 与热备双通道）',
    },
    {
      relative: 'data/logs',
      absolute: logsDir(root),
      reason: 'DEBUG=1 时的完整请求/响应落盘（含用户输入与菜谱正文，spec §4 要求随 .env 一起排除）',
    },
  ];
}

/** 当前权限位（八进制），文件不存在返回 undefined */
export function envMode(root: string): number | undefined {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return undefined;
  // 只看权限的 9 个位（0o777 掩码），其余位（setuid 之类）与本议题无关
  return fs.statSync(file).mode & 0o777;
}

/**
 * 把 `.env` 校正成 600。返回是否真的改动了（幂等：已经是 600 就不动，避免每次 install 都改 mtime）。
 *
 * 文件不存在时**不创建**：没有 key 的部署是合法形态（推荐走简化推荐，其余功能照常），
 * 凭空造一个空 `.env` 反而让人以为「密钥配好了」。
 */
export function ensureEnvMode(root: string): { changed: boolean; mode?: number } {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return { changed: false };
  const before = fs.statSync(file).mode & 0o777;
  if (before === ENV_MODE) return { changed: false, mode: before };
  fs.chmodSync(file, ENV_MODE);
  return { changed: true, mode: fs.statSync(file).mode & 0o777 };
}

/** 某条路径当前是否被 Time Machine 排除（`tmutil isexcluded` 的 `[Excluded]` 前缀） */
export function isTimeMachineExcluded(target: string): boolean {
  try {
    const output = execFileSync('/usr/bin/tmutil', ['isexcluded', target], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
    return output.includes('[Excluded]');
  } catch {
    // 读不到就当作「未排除」：宁可多做一次 addexclusion，也不要谎报已排除
    return false;
  }
}

/** 把一条路径加进 Time Machine 排除（幂等；已排除时不动） */
export function excludeFromTimeMachine(target: string): boolean {
  if (isTimeMachineExcluded(target)) return false;
  execFileSync('/usr/bin/tmutil', ['addexclusion', target], { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
  return true;
}

/**
 * 排除清单的落地形态（`deploy/tm-exclusions.txt`）：装一次、留一份，供人工核对与重装时对照。
 *
 * 写成文件而不是只打印一遍：`tmutil` 的排除项在系统重装/迁移后会丢，
 * 而这份文件随仓库走，是恢复它的依据。
 */
export function renderExclusionsFile(root: string, status: { path: string; excluded: boolean }[]): string {
  const lines = [
    '# 备份排除清单（Time Machine 与热备双通道）',
    '#',
    '# 由 `pnpm deploy:install` 生成，勿手工编辑。恢复/换机后按本清单重加：',
    '#   tmutil addexclusion <path>     # 逐条执行下面每行路径',
    '#   tmutil isexcluded <path>       # 核对（应输出 [Excluded]）',
    '#',
    '# 为什么排除：',
    ...secretPaths(root).map((entry) => `#   ${entry.relative} —— ${entry.reason}`),
    '#',
    '# 路径（绝对）：',
  ];
  for (const entry of status) {
    lines.push(`${entry.excluded ? '✓' : '✗'} ${entry.path}`);
  }
  return `${lines.join('\n')}\n`;
}
