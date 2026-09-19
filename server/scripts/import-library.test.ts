import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listXiachufangEntries } from './import-library.js';

/**
 * 下厨房那条路的 `sourceRef` 必须**如实**（AC）——它是一个页面 URL，报告里留着回溯。
 *
 * 这一条测的是「真 URL 从哪里来」：`fetch-xiachufang.ts` 把详情页地址写进 `<dir>/manifest.json`，
 * 导入侧只信它；**不许**从文件名序号拼一个 `https://www.xiachufang.com/recipe/<序号>/`
 * （那不是页面地址，而它还会当选草稿 id 的 key）。manifest 缺失时也要如实降级，不静默拼假 URL。
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dinner-xcf-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(entries: unknown): void {
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ fetchedAt: '2025-09-19T00:00:00.000Z', source: 'https://www.xiachufang.com/explore/', entries }),
    'utf8',
  );
}

describe('下厨房目录 → 导入条目的读法', () => {
  it('从 manifest.json 读真 URL 与菜名（不是从文件名序号拼的假 URL）', () => {
    fs.writeFileSync(path.join(dir, '01-蒜蓉蚝油生菜.html'), '<html></html>', 'utf8');
    writeManifest([{ name: '蒜蓉蚝油生菜', url: 'https://www.xiachufang.com/recipe/107491076/', file: '01-蒜蓉蚝油生菜.html' }]);

    const { entries, missing } = listXiachufangEntries(dir);
    expect(missing).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('蒜蓉蚝油生菜');
    // 真 URL：序号拼出来的 `recipe/1/` 是假的，这里必须是 manifest 里那条
    expect(entries[0]!.url).toBe('https://www.xiachufang.com/recipe/107491076/');
    expect(entries[0]!.file).toBe(path.join(dir, '01-蒜蓉蚝油生菜.html'));
  });

  it('manifest 缺失就抛（调用方降级成「这条腿不可用」），不猜 URL', () => {
    fs.writeFileSync(path.join(dir, '01-蒜蓉蚝油生菜.html'), '<html></html>', 'utf8');
    expect(() => listXiachufangEntries(dir)).toThrow(/manifest\.json/);
  });

  it('manifest 形状不对、或条目缺 name/url/file 都抛（坏在明处）', () => {
    writeManifest({ not: 'an array' });
    expect(() => listXiachufangEntries(dir)).toThrow(/entries/);

    writeManifest([{ name: '蒜蓉蚝油生菜', file: '01-蒜蓉蚝油生菜.html' }]);
    expect(() => listXiachufangEntries(dir)).toThrow(/url/);
  });

  it('manifest 登记了、目录里没有的文件如实报进 missing（不静默跳过）', () => {
    writeManifest([{ name: '蒜蓉蚝油生菜', url: 'https://www.xiachufang.com/recipe/107491076/', file: '01-蒜蓉蚝油生菜.html' }]);
    const { entries, missing } = listXiachufangEntries(dir);
    expect(entries).toEqual([]);
    expect(missing).toEqual(['01-蒜蓉蚝油生菜.html']);
  });
});
