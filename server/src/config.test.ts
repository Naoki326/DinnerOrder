import { describe, expect, it } from 'vitest';
import { joinBase, loadServerConfig, normalizeBasePath, REPO_ROOT, resolveDevApiPort } from './config.js';

describe('normalizeBasePath', () => {
  it('默认与明显等价写法都归一化到根路径', () => {
    expect(normalizeBasePath(undefined)).toBe('/');
    expect(normalizeBasePath(null)).toBe('/');
    expect(normalizeBasePath('')).toBe('/');
    expect(normalizeBasePath('   ')).toBe('/');
    expect(normalizeBasePath('/')).toBe('/');
  });

  it('去掉尾斜杠、补前导斜杠、折叠重复斜杠', () => {
    expect(normalizeBasePath('/dinner')).toBe('/dinner');
    expect(normalizeBasePath('/dinner/')).toBe('/dinner');
    expect(normalizeBasePath('dinner')).toBe('/dinner');
    expect(normalizeBasePath('//dinner//sub//')).toBe('/dinner/sub');
  });

  it('`.` 与 `./` 视为根（与 web 侧同一语义）', () => {
    expect(normalizeBasePath('.')).toBe('/');
    expect(normalizeBasePath('./')).toBe('/');
  });

  it('非法输入直接抛错（静默兜底会让部署问题极难排查）', () => {
    expect(() => normalizeBasePath('/dinner?x=1')).toThrow(/查询串/);
    expect(() => normalizeBasePath('/dinner#a')).toThrow(/锚点/);
    expect(() => normalizeBasePath('/../etc')).toThrow(/\.\./);
  });
});

describe('joinBase', () => {
  it('根路径下原样返回', () => {
    expect(joinBase('/', '/api/health')).toBe('/api/health');
    expect(joinBase('/', 'api/health')).toBe('/api/health');
  });

  it('子路径下拼接前缀，端点路径保持相对', () => {
    expect(joinBase('/dinner', '/api/health')).toBe('/dinner/api/health');
    expect(joinBase('/dinner', '/')).toBe('/dinner/');
  });
});

describe('loadServerConfig', () => {
  it('默认值：0.0.0.0:8787、根路径、data 与 dist 下的常规路径', () => {
    const config = loadServerConfig({}, '/repo');
    expect(config).toMatchObject({
      basePath: '/',
      host: '0.0.0.0',
      port: 8787,
      dbPath: '/repo/data/dinner.db',
      webDistDir: '/repo/web/dist',
      migrationsDir: '/repo/server/migrations',
    });
  });

  it('BASE_PATH / PORT / 各目录覆盖都生效', () => {
    const config = loadServerConfig(
      {
        BASE_PATH: '/dinner/',
        PORT: '9123',
        HOST: '127.0.0.1',
        DB_PATH: 'var/x.db',
        WEB_DIST_DIR: 'out/web',
        MIGRATIONS_DIR: 'migrations',
      },
      '/repo',
    );
    expect(config).toMatchObject({
      basePath: '/dinner',
      host: '127.0.0.1',
      port: 9123,
      dbPath: '/repo/var/x.db',
      webDistDir: '/repo/out/web',
      migrationsDir: '/repo/migrations',
    });
  });

  it('PORT 非法时抛错', () => {
    expect(() => loadServerConfig({ PORT: 'abc' }, '/repo')).toThrow(/PORT/);
    expect(() => loadServerConfig({ PORT: '70000' }, '/repo')).toThrow(/PORT/);
  });

  it('空字符串的 WEB_DIST_DIR 视为未配置（回退到默认产物目录）', () => {
    expect(loadServerConfig({ WEB_DIST_DIR: '' }, '/repo').webDistDir).toBe('/repo/web/dist');
  });

  it('默认从模块自身定位仓库根，不受进程启动目录影响', () => {
    // REPO_ROOT 在开发时是 server/src/../..、构建后是 server/dist/../..，都是仓库根
    expect(REPO_ROOT.endsWith('/')).toBe(true);
    expect(loadServerConfig({}).webDistDir).toBe(`${REPO_ROOT}web/dist`);
  });
});

describe('resolveDevApiPort', () => {
  it('缺省 8788；未配置、空串、空白一律回落到它', () => {
    // 空串必须与「未配置」同效，否则 API 落 8787、Vite 代理指 8788，
    // 又变回「前端打得开、API 全挂」那个坑
    expect(resolveDevApiPort({})).toBe(8788);
    expect(resolveDevApiPort({ DEV_API_PORT: '' })).toBe(8788);
    expect(resolveDevApiPort({ DEV_API_PORT: '   ' })).toBe(8788);
  });

  it('显式配置生效；非法值抛错（不静默降级）', () => {
    expect(resolveDevApiPort({ DEV_API_PORT: '9999' })).toBe(9999);
    expect(() => resolveDevApiPort({ DEV_API_PORT: 'abc' })).toThrow(/DEV_API_PORT/);
    expect(() => resolveDevApiPort({ DEV_API_PORT: '70000' })).toThrow(/DEV_API_PORT/);
  });
});
