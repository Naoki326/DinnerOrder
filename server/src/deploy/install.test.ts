import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSteps, nginxServersDir, retainedExclusions, type InstallPlan } from './install.js';

/**
 * 装机编排（AC：四条部署动作）。
 *
 * 有意**不测**的部分：`launchctl bootstrap` 与 `tmutil addexclusion` 真的改系统状态——
 * 在单测里调用它们会污染跑测试的这台机器（而且 CI/别人机器上结果不同）。那两条由装机实测负责
 * （`docs/deploy/README.md` 的实测记录）。这里守的是**纯逻辑**：计划是否覆盖 AC 的四件事、
 * 现状描述是否现查、dry-run 是否真的不碰文件系统。
 *
 * 这类测试的价值在于「少做一步」这种错：装机脚本最容易的不是写错路径，
 * 而是静静漏掉一步（比如忘了校正 .env 权限），而漏掉的后果要等很久才显形。
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-install-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return {
    root,
    nodePath: '/opt/homebrew/bin/node',
    port: 8787,
    subPathPort: 8786,
    mountPath: '/apps/dinner',
    dbPath: 'data/dinner.db',
    keep: 7,
    ...overrides,
  };
}

describe('装机计划', () => {
  it('AC 的四件事一件不落：常驻服务、每日热备、nginx 片段、密钥权限与排除', () => {
    const actions = installSteps(plan())
      .map((step) => step.action)
      .join('\n');

    expect(actions).toContain('直连服务');
    expect(actions).toContain('子路径服务');
    expect(actions).toContain('每日热备');
    expect(actions).toContain('nginx 片段');
    expect(actions).toContain('.env 权限');
    expect(actions).toContain('Time Machine');
  });

  it('每一步都给出目标绝对路径（装机时第一眼要看的就是「它往哪写」）', () => {
    for (const step of installSteps(plan())) {
      expect(step.target.startsWith('/'), `目标不是绝对路径：${step.target}`).toBe(true);
      expect(step.state.length).toBeGreaterThan(0);
    }
  });

  it('现状是现查的：.env 不存在时如实说「不存在」而不是假装会写一个', () => {
    const before = installSteps(plan()).find((step) => step.action.includes('.env 权限'));
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=占位\n', { mode: 0o600 });
    const after = installSteps(plan()).find((step) => step.action.includes('.env 权限'));

    expect(before?.state).toContain('不存在');
    expect(after?.state).toBe('存在');
  });

  it('nginx 的挂载点与反代目标写进计划（挂错子路径是常见事故）', () => {
    const step = installSteps(plan()).find((entry) => entry.action.includes('nginx 片段'));

    expect(step?.action).toContain('/apps/dinner/');
    // 反代目标是**子路径实例**（8786），不是直连实例（8787）
    expect(step?.action).toContain('127.0.0.1:8786');
    // 目标指向**宿主已有的统一入口配置**（插一行 include 进去），不是新建一个文件
    expect(step?.target).toContain('apps-proxy.conf');
    expect(step?.state).toContain('include');
  });

  it('挂到别的端口时计划跟着变（同一份计划函数驱动文案，不会各写各的）', () => {
    const step = installSteps(plan({ subPathPort: 9999, mountPath: '/dinner' })).find((entry) =>
      entry.action.includes('nginx 片段'),
    );

    expect(step?.action).toContain('127.0.0.1:9999');
    expect(step?.action).toContain('/dinner/');
  });
});

describe('宿主环境探测', () => {
  it('找得到 Homebrew 的 nginx servers 目录（本机）', () => {
    // 本机实测前提：nginx 由 Homebrew 装在 /opt/homebrew（preflight 已核实）
    const dir = nginxServersDir();

    expect(dir === undefined || dir.endsWith('/nginx/servers')).toBe(true);
  });
});

describe('卸载后仍必须保留的排除项', () => {
  it('`.env` 还在盘上时，它必须继续留在排除名单里（否则密钥回到整机备份）', () => {
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=占位\n', { mode: 0o600 });
    fs.mkdirSync(path.join(root, 'data', 'logs'), { recursive: true });

    const retained = retainedExclusions(root);

    expect(retained).toContain(path.join(root, '.env'));
    expect(retained).toContain(path.join(root, 'data', 'logs'));
  });

  it('路径不存在就不算（不给一个不存在的路径反复 addexclusion）', () => {
    // root 里什么都没建
    expect(retainedExclusions(root)).toEqual([]);
  });

  it('只保留明确列出的两处，不扩大到整个仓库', () => {
    fs.writeFileSync(path.join(root, '.env'), 'x\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'README.md'), 'x\n');

    const retained = retainedExclusions(root);

    // 整仓库排除等于「这台机器不再备份这个项目」——那不是 spec 要的
    expect(retained).not.toContain(root);
    expect(retained).not.toContain(path.join(root, 'README.md'));
    expect(retained).toHaveLength(1);
  });
});
