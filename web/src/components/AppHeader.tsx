import { useSlots } from '../api/meals';
import { IdentitySwitcher } from './IdentitySwitcher';
import { SettingsSheet } from './SettingsSheet';
import styles from './AppHeader.module.css';

/**
 * 头部的日期是「今天」的展示信息，**读服务端下发的家庭时区今天**（`GET /api/slots` 的 `today`）。
 *
 * 为什么不再用浏览器时间（本票修的 bug）：餐槽卡的「今天/明天」按**服务端下发的家庭时区日期**
 * 判定（`server/src/domain/family-time.ts` 写死 `Asia/Shanghai`）。本机恰好同区时页头与卡片一致，
 * 但服务器换 TZ、或家人在另一个时区用手机时，页头会显示浏览器本地的日期、「今天」卡却是家庭时区的
 * 日期——两边差一天，看着就像 app 算错了。页头与卡片必须走**同一个基准**。
 *
 * 数据怎么传上来：`AppShell` 比路由页更外层，所以这里自己调一次 `useSlots(3)`。**不会多打接口**——
 * TanStack Query 按 queryKey 共享缓存，HomeView/CompactView/SimpleView 用的是同一个
 * `['slots', 3]`，谁先发起谁取数、其余命中缓存。
 *
 * `today` 还没到位时**不显示任何日期**（留空），而不是退回去用 `new Date()`：那正是要修的 bug，
 * 宁缺毋错。空窗期极短（与餐槽卡同一份查询，卡片显示「读取中…」时页头也没有日期，两边一致）。
 *
 * 仍然**不给 web 侧另建 clock seam**（`clock.ts` 那套是给业务判定做时间旅行的）：这里只是展示
 * 服务端算好的值，前端不再自己算一遍。
 */
function todayLabel(today: string): string {
  const weekdays = '日一二三四五六';
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  // 星期用 UTC 取：`today` 是家庭时区的**日历日期**，本地时区往回退时 getDay 会给出错误的星期
  // （与 CompactView.weekdayOf 同一口径）
  const weekday = weekdays[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month} 月 ${day} 日 · 周${weekday}`;
}

/** 头部：标题 + 日期（服务端家庭时区的今天）+ 常驻身份切换器（总纲 §2.4，无登录） */
export function AppHeader() {
  const slots = useSlots(3);
  const today = slots.data?.today;
  return (
    <header className={styles.header}>
      <div>
        <div className={styles.title}>家餐桌</div>
        <div className="sub" data-testid="header-today">
          {today ? todayLabel(today) : null}
        </div>
      </div>
      {/* 设置（⚙️，M1 只有「视图模式」一项）与身份条并列常驻：两者都是「这台手机的偏好」 */}
      <div className={styles.actions}>
        <SettingsSheet />
        <IdentitySwitcher />
      </div>
    </header>
  );
}
