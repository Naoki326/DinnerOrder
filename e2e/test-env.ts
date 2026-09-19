/**
 * E2E 固定事实（端口与 BASE_PATH 组合）：config 与 spec 共用一份，
 * 避免两边各写一遍数字后悄悄漂移。
 */
export const E2E = {
  root: {
    port: 8790,
    basePath: '/',
  },
  subPath: {
    port: 8791,
    basePath: '/dinner',
  },
  /** 手机尺寸：iPhone 12 一档，本项目手机优先 */
  viewport: { width: 390, height: 844 },
  /** E2E 服务端注入的确定性 fake 模型名（E2E 断言留痕里的模型名时用） */
  fakeModel: 'e2e-fake-llm',
} as const;

export const ROOT_URL = `http://127.0.0.1:${E2E.root.port}`;
export const SUB_PATH_URL = `http://127.0.0.1:${E2E.subPath.port}${E2E.subPath.basePath}/`;
