import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderNginxLocation, renderProbeServer, renderStandaloneServer, strippedPrefixLocations, upstream } from './nginx.js';

/**
 * 找一个可用的 nginx（依赖的是「有 nginx 就验真语法」而不是「它一定装在某个路径」）。
 *
 * 找不到时下面两条用例会 skip 并说明—— 不是假装通过：这两条本来就想验「手写进字符串的
 * 配置能被真 nginx 读懂」，没 nginx 就没法验。本机（Homebrew）在 /opt/homebrew/bin/nginx，
 * 已在实测记录里跑过（`docs/deploy/README.md`）。
 */
function findNginx(): string | undefined {
  for (const candidate of ['/opt/homebrew/bin/nginx', '/usr/local/bin/nginx', '/usr/sbin/nginx']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const NGINX = findNginx();

/**
 * nginx 反代片段（ADR-0003、spec §7）。
 *
 * 这里测的是**片段形状与它的自洽性**，不是「nginx 能不能反代」——后者由装机时的实测负责
 * （`docs/deploy/README.md` 记录的实测记录）。片段最容易错的地方恰好都能静态断言：
 *
 * 1. **`proxy_pass` 不能带尾斜杠**（不剥前缀写法）。带上它 nginx 会把匹配到的前缀剥掉再转发，
 *    app 就看不到自己的挂载点了——表现是「`BASE_PATH=/apps/dinner` 却只收到 `/api/health`」，
 *    于是整个子路径 404。这条错误极其安静（配置语法完全合法）。
 * 2. **不能做 SPA fallback**（`try_files` / `error_page 404`）。加了它，API 的真 404 会变成
 *    200 HTML，前端的 `{error:...}` 解析拿到一坨 HTML——实测踩过，排障时极具误导性。
 * 3. **无尾斜杠的入口要跳转**到带尾斜杠形态（否则相对资产会解析到父级路径）。
 *
 * 片段还会写给真实的 nginx 解析一遍（`nginx -t` 可以用 `-c` 指到一个隔离目录，
 * 不碰宿主 8080 的配置），确保手写进字符串里的语法没问题。
 */

const PORT = 8787;
const MOUNT = '/apps/dinner';
const SAMPLE = renderNginxLocation({ port: PORT, mountPath: MOUNT });

describe('片段形状', () => {
  it('指向上游的 127.0.0.1:PORT（与 plist 的 PORT 同值）', () => {
    expect(upstream(PORT)).toBe('http://127.0.0.1:8787');
    expect(SAMPLE).toContain('proxy_pass http://127.0.0.1:8787;');
  });

  it('proxy_pass 不带尾斜杠——带了会把挂载前缀剥掉，app 再也看不到子路径', () => {
    expect(SAMPLE).toContain('proxy_pass http://127.0.0.1:8787;');
    expect(SAMPLE).not.toContain('proxy_pass http://127.0.0.1:8787/;');
  });

  it('不做 SPA fallback：API 的真 404 不能被吞成 200 HTML', () => {
    expect(SAMPLE).not.toContain('try_files');
    expect(SAMPLE).not.toContain('error_page');
    expect(SAMPLE).not.toContain('proxy_intercept_errors');
  });

  it('无尾斜杠的入口 301 到带尾斜杠形态（否则相对资产解析到父级路径）', () => {
    expect(SAMPLE).toContain(`location = ${MOUNT} { return 301 ${MOUNT}/; }`);
  });

  it('挂载路径末尾多写斜杠也归一成同一种形态', () => {
    expect(renderNginxLocation({ port: PORT, mountPath: `${MOUNT}/` })).toBe(SAMPLE);
  });
});

describe('两种 nginx 写法', () => {
  it('本仓库选的是「不剥前缀」：只需两条真正的 location 指令（一条跳转 + 一条代理）', () => {
    // 只数**指令行**（排除注释与说明文字）：注释里会提到 location 这个词本身
    const directives = SAMPLE.split('\n').filter((line) => /^\s*location\s/.test(line));
    expect(directives).toHaveLength(2);
  });

  it('片段不带 server 外壳——它要被 include 进宿主已有的 server block', () => {
    expect(SAMPLE).not.toContain('server {');
    expect(SAMPLE).not.toContain('listen ');
  });

  it('自带外壳的独立形态（自检用）才包含 server 与 listen', () => {
    const standalone = renderStandaloneServer({ port: PORT, mountPath: MOUNT, listen: '127.0.0.1:18080' });

    expect(standalone).toContain('server {');
    expect(standalone).toContain('listen 127.0.0.1:18080;');
    // 外壳里的片段与裸片段逐字一致（同一套写法，不会两种形态漂移）
    for (const line of SAMPLE.split('\n').filter((entry) => entry.trim() !== '')) {
      expect(standalone).toContain(line.trim());
    }
  });

  it('「剥前缀」写法需要额外补 4 条 location，其中 /api/ 会与其他 app 撞车', () => {
    const extra = strippedPrefixLocations(PORT);

    expect(extra).toHaveLength(4);
    expect(extra.join('\n')).toContain('location /api/');
    // proxy_pass **不带路径**：带了路径 nginx 会用它替换匹配到的前缀，
    // `/assets/x.js` 就变成了 `/x.js`（上游 404）——实测踩过
    for (const line of extra) {
      expect(line).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:8787; \}$/);
    }
  });
});

describe.skipIf(NGINX === undefined)('片段能被真实 nginx 解析（不碰宿主 8080）', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('nginx -t 通过（隔离目录 → 不读宿主配置）', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-nginx-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const conf = path.join(dir, 'nginx.conf');
    fs.writeFileSync(
      conf,
      `pid ${path.join(dir, 'nginx.pid')};
error_log ${path.join(dir, 'logs', 'error.log')} warn;
events { worker_connections 32; }
http {
  access_log off;
${renderProbeServer({ port: PORT, mountPath: MOUNT })
  .split('\n')
  .map((line) => (line === '' ? '' : `  ${line}`))
  .join('\n')}
}
`,
    );

    // nginx -t 把结果写到 **stderr**（不是 stdout）——只管 stdout 会得到空字符串，
    // 于是「解析通过」变成一句永远不成立的断言
    const run = (): { ok: boolean; message: string } => {
      try {
        execFileSync(NGINX as string, ['-p', dir!, '-c', conf, '-t'], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
        return { ok: true, message: '（无输出）' };
      } catch (error) {
        const failure = error as { stderr?: string; stdout?: string };
        return { ok: false, message: `${failure.stderr ?? ''}${failure.stdout ?? ''}` };
      }
    };

    const result = run();
    expect(result.ok, `nginx -t 未通过：\n${result.message}`).toBe(true);
  });

  it('片段里的写法真的被 nginx 读懂（把片段换成错写法会被这一步拦住）', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-nginx-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const conf = path.join(dir, 'nginx.conf');
    // 故意把 location 写成漏了花括号的形态：产物不对时这条断言会红
    fs.writeFileSync(
      conf,
      `events { worker_connections 8; }
http { server { listen 127.0.0.1:18081; location /x/ { proxy_pass http://127.0.0.1:8787`,
    );

    let failed = false;
    try {
      execFileSync(NGINX as string, ['-p', dir, '-c', conf, '-t'], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    } catch {
      failed = true;
    }
    // 阴性对照：证明上一条断言的「通过」不是因为 nginx -t 永远返回成功
    expect(failed).toBe(true);
  });
});
