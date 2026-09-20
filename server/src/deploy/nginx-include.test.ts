import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findServerBlockEnd,
  hasDinnerInclude,
  insertDinnerInclude,
  removeDinnerInclude,
  stripForBalance,
  uninstallFromExistingServer,
} from './nginx-include.js';

/**
 * 往宿主已有 nginx 配置里插入 `include`（用户口径：并入 8080 的 `/apps/` 家族）。
 *
 * 这是整个部署票里**唯一会改用户手写文件**的动作，所以它的测试要覆盖真实文件的形态，
 * 而不是理想化的几行。`servers/apps-proxy.conf` 里有两类真实的坑，下面每条都有对应用例：
 *
 *   * 引号里的花括号与 `#`（`return 200 '<!doctype…style="color:#888">'`）——
 *     按行配平时若不剥字符串，会把 `{` 数错、插到别处；
 *   * 注释掉的花括号（`# map ... { ... }`）——同理。
 *
 * 还有一条只在使用中才会发现的事实：`servers/` 是 **http 上下文**（`include servers/*`），
 * 所以片段必须自带 `server { }`；而往既有 server block 里插的是 `location` 片段。
 * 两种形态在 `nginx.test.ts` 与这里分别钉住。
 */

const FRAGMENT = '/repo/deploy/nginx/dinner-location.conf';

describe('配平前的清洗', () => {
  it('剥掉字符串内容（引号里的 { } 不参与配平）', () => {
    expect(stripForBalance(`return 200 '<p style="color:#888">{x}</p>';`)).not.toContain('{');
    expect(stripForBalance(`return 200 '<p style="color:#888">{x}</p>';`)).not.toContain('#');
  });

  it('剥掉注释里的大括号（注释掉的 map 声明不该影响配平）', () => {
    expect(stripForBalance('#   map "$http_rsc" $piweb_home { ... }')).not.toContain('{');
  });

  it('代码部分原样保留（这才是配平要看的）', () => {
    expect(stripForBalance('server {').trim()).toBe('server {');
  });
});

describe('找到目标 server block', () => {
  it('按 listen 行定位，返回收尾 } 的行号', () => {
    const lines = ['http {', '    server {', '        listen 8080;', '        location / { }', '    }', '}'];

    expect(findServerBlockEnd(lines, 8080)).toBe(4);
  });

  it('多个 server block 时只认 listen 端口匹配的那个', () => {
    const lines = [
      'server {',
      '    listen 8081;',
      '}',
      'server {',
      '    listen 8080;',
      '    location / { }',
      '}',
    ];

    expect(findServerBlockEnd(lines, 8080)).toBe(6);
  });

  it('文件里有别的 app 的字符串花括号也不会数错', () => {
    const lines = [
      'server {',
      '    listen 8080;',
      `    location /sw { return 200 '<p style="color:#888">{ok}</p>'; }`,
      '    # 注释里的 map { }',
      '}',
    ];

    expect(findServerBlockEnd(lines, 8080)).toBe(4);
  });

  it('找不到端口就报错，不猜位置（插错会让整份 nginx 崩掉）', () => {
    expect(() => findServerBlockEnd(['server {', '    listen 9090;', '}'], 8080)).toThrow(/listen 8080/);
  });

  it('大括号不配平时报错，不强行插入', () => {
    expect(() => findServerBlockEnd(['server {', '    listen 8080;', '    location / {'], 8080)).toThrow(/配平/);
  });
});

describe('插入 include', () => {
  const BASE = ['http {', '    server {', '        listen 8080;', '        location / { }', '    }', '}'].join('\n');

  it('插在目标 block 的收尾 } 之前，并用绝对路径', () => {
    const { text, changed } = insertDinnerInclude(BASE, FRAGMENT, 8080);

    expect(changed).toBe(true);
    const lines = text.split('\n');
    const includeLine = lines.findIndex((line) => line.includes(FRAGMENT));
    const closing = lines.findIndex((line, index) => index > includeLine && line.trim() === '}');
    expect(includeLine).toBeGreaterThan(0);
    expect(includeLine).toBeLessThan(closing);
    // include 必须在 8080 那个 block 内（540 结尾的 } 是 http 的，不该排在我们前面）
    expect(lines[includeLine - 2]).toContain('location / { }');
  });

  it('幂等：已经有 include 时不再插第二行', () => {
    const first = insertDinnerInclude(BASE, FRAGMENT, 8080);
    const second = insertDinnerInclude(first.text, FRAGMENT, 8080);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.text.split('\n').filter((line) => line.includes(FRAGMENT))).toHaveLength(1);
  });

  it('探测函数认得出已插入状态', () => {
    const { text } = insertDinnerInclude(BASE, FRAGMENT, 8080);

    expect(hasDinnerInclude(text)).toBe(true);
    expect(hasDinnerInclude(BASE)).toBe(false);
  });

  it('保留插入点原有的缩进（与人手写的风格一致，diff 才干净）', () => {
    const { text } = insertDinnerInclude(BASE, FRAGMENT, 8080);

    const lines = text.split('\n');
    const includeLine = lines.find((line) => line.includes(FRAGMENT)) as string;
    expect(includeLine.startsWith('    include ')).toBe(true);
  });
});

describe('撤销 include', () => {
  const BASE = ['http {', '    server {', '        listen 8080;', '        location / { }', '    }', '}'].join('\n');

  it('装完再撤，文件回到原样（不留空行堆积）', () => {
    const installed = insertDinnerInclude(BASE, FRAGMENT, 8080);
    const removed = removeDinnerInclude(installed.text);

    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(BASE);
  });

  it('幂等：没装过也能安全调用', () => {
    const removed = removeDinnerInclude(BASE);

    expect(removed.changed).toBe(false);
    expect(removed.text).toBe(BASE);
  });

  it('装/卸两轮后仍是原样（反复重装不留垃圾）', () => {
    let text = BASE;
    for (let i = 0; i < 2; i += 1) {
      text = insertDinnerInclude(text, FRAGMENT, 8080).text;
      text = removeDinnerInclude(text).text;
    }

    expect(text).toBe(BASE);
  });
});

describe('真文件上的装卸（片段是仓库文件，不能删）', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('卸载只撤 include，**不删**片段文件（它是受版本控制的仓库文件）', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-nginx-inc-'));
    const confPath = path.join(dir, 'apps-proxy.conf');
    const repoFragment = path.join(dir, 'deploy', 'nginx', 'dinner-location.conf');
    fs.mkdirSync(path.dirname(repoFragment), { recursive: true });
    fs.writeFileSync(confPath, ['http {', '    server {', '        listen 8080;', '    }', '}'].join('\n'));
    fs.writeFileSync(repoFragment, '# 受版本控制的片段\n');

    insertDinnerInclude(fs.readFileSync(confPath, 'utf8'), repoFragment, 8080);
    // 先把 include 写进去（模拟装机后的状态）
    const installed = insertDinnerInclude(
      fs.readFileSync(confPath, 'utf8'),
      repoFragment,
      8080,
    );
    fs.writeFileSync(confPath, installed.text);

    const result = uninstallFromExistingServer({ confPath });

    expect(result.includeRemoved).toBe(true);
    expect(fs.readFileSync(confPath, 'utf8')).not.toContain(repoFragment);
    // 关键：片段文件还在（删它会把工作区弄脏——git status 里冒出一个意外删除）
    expect(fs.existsSync(repoFragment)).toBe(true);
  });

  it('没装过时卸载是幂等的（不报错、不改文件）', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-nginx-inc-'));
    const confPath = path.join(dir, 'apps-proxy.conf');
    const original = ['http {', '    server {', '        listen 8080;', '    }', '}'].join('\n');
    fs.writeFileSync(confPath, original);

    const result = uninstallFromExistingServer({ confPath });

    expect(result.includeRemoved).toBe(false);
    expect(fs.readFileSync(confPath, 'utf8')).toBe(original);
  });
});
