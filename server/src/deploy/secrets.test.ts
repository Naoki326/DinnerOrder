import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENV_MODE, ensureEnvMode, envMode, renderExclusionsFile, secretPaths } from './secrets.js';

/**
 * 密钥边界（spec §4/§7、AC：`.env` chmod 600 且排除出双备份通道）。
 *
 * 这里只测**能确定的东西**：权限位与清单内容。`tmutil addexclusion` 是否真的生效属于
 * 系统状态，写进测试会变成「在一台没配 Time Machine 的机器上红」的环境依赖测试——
 * 那类断言放在装机实测里（`docs/deploy/README.md` 的实测记录），本文件不假装能测它。
 *
 * 为什么权限位值得单测：`.env` 里是付费 key，而 `chmod` 这种事「文档里写一句请记得」
 * 必然会在某次重装时漏掉。把它做成 `install` 的副作用，就得有测试钉住这个副作用。
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-secrets-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeEnv(mode: number): string {
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'OPENAI_API_KEY=占位\n', { mode });
  fs.chmodSync(file, mode);
  return file;
}

describe('.env 的权限', () => {
  it('过宽的权限被校正成 600', () => {
    writeEnv(0o644);

    const result = ensureEnvMode(root);

    expect(result.changed).toBe(true);
    expect(envMode(root)).toBe(ENV_MODE);
  });

  it('已经是 600 就不动（幂等：不每次 install 都改 mtime）', () => {
    writeEnv(ENV_MODE);

    const result = ensureEnvMode(root);

    expect(result.changed).toBe(false);
    expect(envMode(root)).toBe(ENV_MODE);
  });

  it('没有 .env 时不凭空创建（没配 key 是合法形态，空文件会让人以为配好了）', () => {
    const result = ensureEnvMode(root);

    expect(result.changed).toBe(false);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });
});

describe('排除清单', () => {
  it('.env 与 data/logs 都在清单里（两条通道都指的这两处）', () => {
    const relatives = secretPaths('/repo').map((entry) => entry.relative);

    expect(relatives).toEqual(['.env', 'data/logs']);
    expect(secretPaths('/repo')[0]?.absolute).toBe('/repo/.env');
    expect(secretPaths('/repo')[1]?.absolute).toBe('/repo/data/logs');
  });

  it('清单文件带绝对路径与勾选状态，且说明为什么排除（换机后照它重加）', () => {
    const text = renderExclusionsFile('/repo', [
      { path: '/repo/.env', excluded: true },
      { path: '/repo/data/logs', excluded: false },
    ]);

    expect(text).toContain('tmutil addexclusion');
    expect(text).toContain('✓ /repo/.env');
    // 未排除的条目要看得出来（✗ 就是待办）
    expect(text).toContain('✗ /repo/data/logs');
    expect(text).toContain('LLM API key');
  });

  it('清单里不出现密钥内容（清单本身也是会被读、被贴的文件）', () => {
    writeEnv(ENV_MODE);
    const text = renderExclusionsFile(root, [{ path: path.join(root, '.env'), excluded: true }]);

    expect(text).not.toContain('占位');
  });
});
