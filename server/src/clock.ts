/**
 * 时钟 seam（**服务端业务判定用**）：所有「现在几点」的**判定**都经过注入的 Clock，
 * 不在服务端业务代码里直接 new Date()。餐槽的「当前时刻之后」判定、去重窗口、冷藏期到期、
 * 小孩年龄分带都要能被测试拨动（本票只落桩）。
 *
 * 纯 UI 展示的日期（如 AppHeader 的「今天」）不走这条 seam——它不参与任何判定。
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
