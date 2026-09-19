import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_CONFIG_MARKER, renderIndexHtml, renderManifest } from './static.js';
import { createTestHarness, type TestHarness } from './testing/harness.js';

let tmpDir: string;
let harness: TestHarness;

afterEach(() => {
  harness?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 造一份「像 Vite 产物」的目录：index.html（含注入标记）+ 相对引用的 assets + manifest */
function createWebDist(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-webdist-'));
  fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'index.html'),
    `<!doctype html><html><head><script>${APP_CONFIG_MARKER}</script><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`,
    'utf8',
  );
  fs.writeFileSync(path.join(tmpDir, 'assets', 'app.js'), 'console.log("app");', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'manifest.webmanifest'), JSON.stringify({ name: '家餐桌', start_url: '/', scope: '/' }), 'utf8');
  return tmpDir;
}

describe('renderIndexHtml', () => {
  it('把标记替换成 window.__APP_CONFIG__ 注入脚本', () => {
    const html = renderIndexHtml(`<html><head><script>${APP_CONFIG_MARKER}</script></head></html>`, '/dinner');
    expect(html).toContain('window.__APP_CONFIG__={"basePath":"/dinner"};');
    expect(html).not.toContain(APP_CONFIG_MARKER);
  });

  it('缺标记时抛错（产物与服务端约定不一致，不能默默返回没注入的 HTML）', () => {
    expect(() => renderIndexHtml('<html></html>', '/')).toThrow(/注入标记/);
  });

  it('注入值里的 </script> 被转义', () => {
    const html = renderIndexHtml(`<script>${APP_CONFIG_MARKER}</script>`, '</script><b>');
    expect(html).not.toContain('</script><b>');
  });
});

describe('renderManifest', () => {
  it('按 basePath 推导 start_url / scope', () => {
    expect(JSON.parse(renderManifest('{"name":"家餐桌"}', '/'))).toMatchObject({ start_url: './', scope: './' });
    expect(JSON.parse(renderManifest('{"name":"家餐桌"}', '/dinner'))).toMatchObject({
      start_url: '/dinner/',
      scope: '/dinner/',
    });
  });
});

describe('单进程一体：API + 静态产物在同一个 app 上', () => {
  it('根路径：首页注入 basePath=/，assets 相对引用可解析', async () => {
    harness = createTestHarness({ webDistDir: createWebDist() });

    const index = await harness.request('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toMatch(/text\/html/);
    const html = await index.text();
    expect(html).toContain('window.__APP_CONFIG__={"basePath":"/"};');
    expect(html).toContain('src="./assets/app.js"'); // 相对引用，换挂载点无需重打包

    const asset = await harness.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("app");');

    const manifest = await harness.request('/manifest.webmanifest');
    expect(JSON.parse(await manifest.text())).toMatchObject({ start_url: './', scope: './' });
  });

  it('子路径：同一份产物挂在 /dinner 下，注入与资源路径同时随之', async () => {
    harness = createTestHarness({ basePath: '/dinner', webDistDir: createWebDist() });

    const index = await harness.request('/dinner/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('window.__APP_CONFIG__={"basePath":"/dinner"};');

    // 相对引用 './assets/app.js' 在 /dinner/ 下解析成 /dinner/assets/app.js
    const asset = await harness.request('/dinner/assets/app.js');
    expect(asset.status).toBe(200);

    // manifest 的 start_url/scope 跟着走（挂子路径也能正确加到主屏）
    const manifest = await harness.request('/dinner/manifest.webmanifest');
    expect(JSON.parse(await manifest.text())).toMatchObject({ start_url: '/dinner/', scope: '/dinner/' });

    // API 前缀也随 basePath
    expect((await harness.json('/dinner/api/health')).status).toBe(200);
    expect((await harness.json('/api/health')).status).toBe(404);
  });

  it('子路径无尾斜杠的入口请求重定向到带斜杠形态（否则相对资产会解析到父级）', async () => {
    harness = createTestHarness({ basePath: '/dinner', webDistDir: createWebDist() });
    const response = await harness.request('/dinner', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dinner/');
  });

  it('未匹配的深链交给 SPA fallback（前端 Router 拿得到 index.html）', async () => {
    harness = createTestHarness({ webDistDir: createWebDist() });
    const response = await harness.request('/买菜');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('window.__APP_CONFIG__');
  });

  it('缺失的构建资源返回 404 而不是 HTML（否则浏览器报的是误导性的 MIME 错）', async () => {
    harness = createTestHarness({ webDistDir: createWebDist() });
    for (const path of ['/assets/nope.js', '/favicon.ico']) {
      const response = await harness.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe('Not Found');
    }
  });

  it('缺产物目录时 API 照常可用，根路径给 api-only 提示（开发模式：静态侧由 Vite 提供）', async () => {
    harness = createTestHarness({ basePath: '/dinner' });
    expect((await harness.json('/dinner/api/health')).status).toBe(200);

    const index = await harness.json<{ mode: string }>('/dinner/');
    expect(index.status).toBe(200);
    expect(index.body.mode).toBe('api-only');
  });
});
