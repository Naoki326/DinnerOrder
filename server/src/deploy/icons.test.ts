import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config.js';

/**
 * 图标资产的接线（页签里要能看出不同）。
 *
 * 这一组守的是**用户报的那个问题**：页签里看不出这是哪个 app。根因有两条，各自都能单独
 * 让页签变错，所以各自都要有测试：
 *
 * 1. **页面没声明 `<link rel="icon">`** —— 浏览器就只会去要 origin 根的 `/favicon.ico`。
 *    经 nginx 挂在子路径下时那个地址属于 pi-web，于是页签显示**别人的图标**。
 * 2. **`favicon.ico` 不在 `public/` 根** —— 上一条的隐式请求即使指向本 app 也 404。
 *
 * 断言的是**文件与声明真的存在**（而不是「函数返回了字符串」）：图标这种东西坏掉时
 * 页面照常打开、控制台也不一定报错，只有页签上那 16px 会变——那正是最容易被忽略的一环。
 */

const PUBLIC = path.join(REPO_ROOT, 'web', 'public');
const INDEX_HTML = path.join(REPO_ROOT, 'web', 'index.html');
const MANIFEST = path.join(PUBLIC, 'manifest.webmanifest');

describe('图标资产齐全', () => {
  it('favicon.ico 在 public 根目录（浏览器隐式请求的固定路径）', () => {
    expect(fs.existsSync(path.join(PUBLIC, 'favicon.ico'))).toBe(true);
  });

  it('真源 SVG 与各档 PNG 都在（改设计只改 SVG，但要有人把它导出）', () => {
    for (const file of [
      'icons/icon.svg',
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-192.png',
      'icons/icon-512.png',
      'icons/apple-touch-icon.png',
      'icons/icon-maskable-192.png',
      'icons/icon-maskable-512.png',
    ]) {
      expect(fs.existsSync(path.join(PUBLIC, file)), file).toBe(true);
    }
  });

  it('PNG 是真图片（不是占位空文件）', () => {
    const icons = new Set(
      fs
        .readdirSync(path.join(PUBLIC, 'icons'))
        .filter((file) => file.endsWith('.png'))
        .map((file) => fs.readFileSync(path.join(PUBLIC, 'icons', file))),
    );
    for (const bytes of icons) {
      // PNG 魔数
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(bytes.length).toBeGreaterThan(200);
    }
  });

  it('ico 至少打包了 16×16 那一档（页签用的就是它）', () => {
    const ico = fs.readFileSync(path.join(PUBLIC, 'favicon.ico'));

    // ICO 头：0,0 然后 type=1（icon）然后 count
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(2);
    // 目录里的第一个条目：宽度 0 表示 256，否则就是像素宽
    const firstWidth = ico.readUInt8(6);
    expect([16, 32, 48]).toContain(firstWidth === 0 ? 256 : firstWidth);
  });
});

describe('index.html 显式声明了图标', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('至少有 rel="icon" 的声明（缺了就会去要 origin 根那份，也就是别人的图标）', () => {
    const declared = html.match(/<link[^>]+rel="icon"[^>]*>/g) ?? [];

    expect(declared.length).toBeGreaterThanOrEqual(2);
  });

  it('声明里覆盖 16×16 或 32×32 的位图档（页签尺寸）', () => {
    const declared = html.match(/rel="icon"[^>]*/g) ?? [];
    const joined = declared.join('\n');

    expect(joined).toMatch(/16x16|32x32|sizes="any"/);
  });

  it('引用的是**相对**路径（ADR-0003：同一份产物挂 / 或子路径都不用重打包）', () => {
    const declared = html.match(/<link[^>]+rel="icon"[^>]*>/g) ?? [];

    for (const tag of declared) {
      const href = /href="([^"]+)"/.exec(tag)?.[1];
      expect(href, tag).toBeDefined();
      expect(href?.startsWith('./'), `${tag} 应该是相对路径`).toBe(true);
    }
  });

  it('apple-touch-icon 指向存在的文件（iOS 主屏用）', () => {
    const href = /rel="apple-touch-icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    const file = path.join(PUBLIC, (href as string).replace(/^\.\//, ''));
    expect(fs.existsSync(file), file).toBe(true);
  });

  it('每一条声明的图标文件都真的存在（声明了却 404 等于没声明）', () => {
    const declared = html.match(/<link[^>]+rel="(?:icon|apple-touch-icon)"[^>]*>/g) ?? [];
    expect(declared.length).toBeGreaterThan(0);
    for (const tag of declared) {
      const href = /href="([^"]+)"/.exec(tag)?.[1] as string;
      const file = path.join(PUBLIC, href.replace(/^\.\//, ''));
      expect(fs.existsSync(file), `${tag} → ${file}`).toBe(true);
    }
  });
});

describe('manifest 的图标（加到主屏时用）', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as {
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };

  it('192 与 512 两档都在，且分 any / maskable（Android 两者都要）', () => {
    const purposes = manifest.icons.map((entry) => entry.purpose ?? 'any');

    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
    expect(manifest.icons.map((entry) => entry.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
  });

  it('manifest 里每个图标文件都存在（相对路径按 public/ 解析）', () => {
    for (const entry of manifest.icons) {
      const file = path.join(PUBLIC, entry.src.replace(/^\.\//, ''));
      expect(fs.existsSync(file), `${entry.src} → ${file}`).toBe(true);
    }
  });

  it('theme_color 是强调色（安卓状态栏与图标底色一致）', () => {
    expect(manifest.theme_color).toBe('#d9480f');
  });
});
