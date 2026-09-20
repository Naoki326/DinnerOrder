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
    const html = renderIndexHtml(`<head><script>${APP_CONFIG_MARKER}</script></head>`, '</script><b>');
    expect(html).not.toContain('</script><b>');
  });

  it('注入 <base href>：深链（带额外路径段）下相对资产才不会解析到错位置', () => {
    const html = renderIndexHtml(
      `<html><head><script>${APP_CONFIG_MARKER}</script><script src="./assets/app.js"></script></head></html>`,
      '/dinner',
    );
    // 拔掉 base 后，/dinner/slot/x 页会把 './assets/app.js' 解析成 /dinner/slot/assets/app.js（404 白屏）
    expect(html).toContain('<base href="/dinner/" />');
    expect(renderIndexHtml(`<head>${APP_CONFIG_MARKER}</head>`, '/')).toContain('<base href="/" />');
  });

  it('产物里已有 base 时不重复注入（两份 base 的生效规则会让人误以为改动没生效）', () => {
    const html = renderIndexHtml(`<head><base href="./" />${APP_CONFIG_MARKER}</head>`, '/');
    expect(html.match(/<base/gi)?.length).toBe(1);
  });

  it('没有 <head> 时直接报错（否则深链会静默白屏）', () => {
    expect(() => renderIndexHtml(`<div>${APP_CONFIG_MARKER}</div>`, '/')).toThrow(/head/);
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
    const html = await response.text();
    expect(html).toContain('window.__APP_CONFIG__');
    // 深链必须带 <base href>：否则 './assets/app.js' 会从 /买菜/ 解析（404 白屏）
    expect(html).toContain('<base href="/" />');
  });

  it('定餐编辑器这类多段深链：assets 请求路径与根路径完全相同', async () => {
    harness = createTestHarness({ webDistDir: createWebDist() });
    // 浏览器按 <base href="/"> 把 './assets/app.js' 解析成 /assets/app.js —— 与首页一致
    const deepLink = await harness.request('/slot/2025-06-01:dinner');
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain('<base href="/" />');
    expect((await harness.request('/assets/app.js')).status).toBe(200);

    // 子路径下的同一件事：/dinner/slot/x 的资产走 /dinner/assets/...
    harness.close();
    harness = createTestHarness({ basePath: '/dinner', webDistDir: createWebDist() });
    expect(await (await harness.request('/dinner/slot/2025-06-01:dinner')).text()).toContain(
      '<base href="/dinner/" />',
    );
    expect((await harness.request('/dinner/assets/app.js')).status).toBe(200);
  });

  it('缺失的构建资源返回 404 而不是 HTML（否则浏览器报的是误导性的 MIME 错）', async () => {
    // 用**真实不存在**的文件名：`favicon.ico` 曾经是个好例子，但自从仓库提供了它，
    // 拿它当「缺失资源」只会让这条用例随图标票一起变红（写死一个会同名文件就自相矛盾）
    harness = createTestHarness({ webDistDir: createWebDist() });
    for (const path of ['/assets/nope.js', '/icons/nope.png', '/favicon.ico']) {
      const response = await harness.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe('Not Found');
    }
  });

  it('有产物时 favicon.ico 按二进制送出（不是 404、也不是被当成深链返回 index.html）', async () => {
    const dist = createWebDist();
    // 写一个最小「看起来像 ico」的字节串（static 层只负责按扩展名送文件，不解析内容）
    fs.writeFileSync(path.join(dist, 'favicon.ico'), Buffer.from([0x00, 0x00, 0x01, 0x00]));
    harness = createTestHarness({ webDistDir: dist });

    const response = await harness.request('/favicon.ico');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image');
  });

  it('缺产物目录时 API 照常可用，根路径给 api-only 提示（开发模式：静态侧由 Vite 提供）', async () => {
    harness = createTestHarness({ basePath: '/dinner' });
    expect((await harness.json('/dinner/api/health')).status).toBe(200);

    const index = await harness.json<{ mode: string }>('/dinner/');
    expect(index.status).toBe(200);
    expect(index.body.mode).toBe('api-only');
  });
});
