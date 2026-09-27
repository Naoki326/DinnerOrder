/**
 * 「周X M/D」——`'YYYY-MM-DD'` 的日头写法。
 *
 * 用 **UTC** 取星期：服务端下发的日期是**家庭时区**的日历日期，本地时区往回退时
 * `getDay()` 会给出错误的星期（多台设备/多时区下会看出不一致）。
 *
 * 收拢成一处（#31）：按天分组的几个摆法（B 紧凑流的日头、宽版首页的时间轴）都要这一行，
 * 抄两遍就会在「用 UTC 还是本地」这类细节上漂移（`AppHeader` 的 `todayLabel` 是同口径的
 * 第三种写法，那里还多一个「今天/明天/后天」的包装）。
 */
export function weekdayOf(date: string): string {
  const weekday = '日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `周${weekday} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}
