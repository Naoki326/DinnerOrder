/** 服务端注入的运行时配置在页面全局上（ADR-0003），e2e 里会读它做断言。 */
declare global {
  interface Window {
    __APP_CONFIG__?: { basePath?: string };
  }
}

export {};
