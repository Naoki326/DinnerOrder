/**
 * 「家里的日期」——餐槽判定用的时间基准。
 *
 * 餐槽是「日期 × 午/晚」的家庭日历概念：家里说的「今天晚餐」是**本地日历**上的今天，
 * 而注入的 Clock 给的是 UTC 瞬间。两者之间必须有一次显式的换算，否则同一个瞬间在不同
 * 时区会折出不同的餐槽（服务器在 UTC 跑、家人在东八区吃饭）。
 *
 * 家庭时区先写死 `Asia/Shanghai`（自家工具，一家人一个时区），比「读服务器本地时区」可靠：
 * 服务器换了机房/容器默认 TZ 也不会把「今天」挪一天。若日后要支持跨时区，这里改成一个配置项。
 *
 * 实现用 Intl 算偏移，不硬编码 +8：夏令时/时区规则交给 ICU（Asia/Shanghai 现在无夏令时，
 * 但把规则抄进代码就是等着它过期）。
 */

/** 家庭的日历时区（餐槽日期、截止时刻、时令月份都按它算） */
export const FAMILY_TIME_ZONE = 'Asia/Shanghai';

// 餐次截止时刻（家规）**不在这个文件里**：自 #20 起它在 `family_rules` 表
// （`lunch_cutoff_hour` / `dinner_cutoff_hour`，缺省午 14:00 / 晚 21:00，总纲 §3
// 「家规 = 单例配置，全部可调」）。运行时判定一律读表（`domain/family-rules.ts` 的
// `familyRules` + `domain/slots.ts` 的 `hasMealPassed`）——这里不再留一份会与库漂移的
// 常量副本。要调家规请改表。

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FAMILY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const wallClockFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: FAMILY_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 某个瞬间在家庭时区里的墙上时间 */
function wallClock(instant: Date): WallClock {
  const parts: Partial<Record<keyof WallClock, number>> = {};
  for (const part of wallClockFormatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type as keyof WallClock] = Number(part.value);
  }
  return parts as WallClock;
}

/** 家庭时区相对 UTC 的偏移（毫秒；东八区为 +8h） */
function zoneOffsetMs(instant: Date): number {
  const wall = wallClock(instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

/** 家庭时区的墙上时间 → UTC 瞬间（先按 UTC 猜一次、再用该时刻的偏移校正；跨 DST 两次足够） */
export function familyInstant(date: string, hour: number, minute = 0): Date {
  const { year, month, day } = parseDate(date)!;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const guess = new Date(naive - zoneOffsetMs(new Date(naive)));
  return new Date(naive - zoneOffsetMs(guess));
}

/** 瞬间落在家庭时区的哪一天（'YYYY-MM-DD'） */
export function familyDate(instant: Date): string {
  return dateFormatter.format(instant);
}

/** 日历日期加天数（纯日期算术，不碰时区——日期本身没有时间） */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date)!;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** 解析 'YYYY-MM-DD'；格式不对返回 undefined（调用方决定怎么报错） */
export function parseDate(date: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // 还原一次，挡掉 2025-02-31 这种「格式对但不存在」的日期
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    return undefined;
  }
  return { year, month, day };
}
