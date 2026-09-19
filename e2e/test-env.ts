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
  /** LLM 每次调用都失败的一个实例，专验 S7 降级（界面给简化推荐并显著标记） */
  llmDown: {
    port: 8792,
    basePath: '/',
  },
  /** 手机尺寸：iPhone 12 一档，本项目手机优先 */
  viewport: { width: 390, height: 844 },
  /** E2E 服务端注入的确定性 fake 模型名（E2E 断言留痕里的模型名时用） */
  fakeModel: 'e2e-fake-llm',
} as const;

export const ROOT_URL = `http://127.0.0.1:${E2E.root.port}`;
export const SUB_PATH_URL = `http://127.0.0.1:${E2E.subPath.port}${E2E.subPath.basePath}/`;
/** LLM 故障实例的地址（S7 降级用例专用） */
export const LLM_DOWN_URL = `http://127.0.0.1:${E2E.llmDown.port}`;
