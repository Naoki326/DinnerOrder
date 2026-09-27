import { useState } from 'react';
import { useFeedback } from '../api/feedback';
import { useSlots, type SlotWithPortion } from '../api/meals';
import { weekdayOf } from '../components/weekday';
import {
  dayLabel,
  HealthFooter,
  HeroCard,
  NoSlots,
  ReleaseNotice,
  SlotsError,
  SlotsLoading,
  useReleaseNotice,
} from './HomeView';
import styles from './HomeWideView.module.css';

/**
 * 平板版首页（#31）：**左列餐槽时间轴 + 右列选中餐的详情**。
 *
 * 平板上的动线问题：首页那张「下一餐大卡」在宽屏上仍是一条竖着的长卡，想对照「明天午餐 vs
 * 明天晚餐」得上下滚，明明横向有一屏的余量。宽版的摆法把这两个动作分开：左列一眼扫完这几天
 * 定了什么、还没定什么；点其中一格，右列当场显示那一餐的详情与全部操作。
 *
 * 与手机版（A）**同一套东西两种摆法**（#31 的统一原则）：同一份 `useSlots(3)` 数据、
 * 同一个 `HeroCard`（右列就是它，连 testid 如 `empty-slot`/`recommend-button`/`hero-dishes`
 * 都不变）、同一份 `useFeedback`。C（长辈小孩极简）的纪律在宽版下也成立——宽版首页没有把
 * 信息塞密：左列每格只有「什么时候 · 定没定 · 菜名预告」，详情在右列一屏一事。
 *
 * 时间轴的槽点包含**全部**餐槽（含已定的），不像手机版 A 把后面那些收进折叠卡：
 * 宽屏的横向余量就是用来做这件事的（story 20）。
 */
export function HomeWideView() {
  const slots = useSlots(3);
  const released = useReleaseNotice();
  const feedback = useFeedback();
  /** 右列选中的那一餐；null = 跟随「最近未定餐槽」（与手机版 A 的取法一致） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = slots.data?.slots ?? [];
  const today = slots.data?.today;
  // 默认选中「最近未定餐槽」（手机版 A 的大卡就是它），没有未定的就退到窗口里第一张
  const fallback = list.find((slot) => slot.status === 'undecided') ?? list[0];
  const selected = list.find((slot) => slot.id === selectedId) ?? fallback;

  return (
    <div data-testid="home-view" data-layout-view="wide">
      <ReleaseNotice released={released} today={today} />

      {/* 三块状态卡与窄版**完全同源**（同一组件、同一 testid、同一句话）：摆法换了，
          文案不该跟着换（宽版这里原先自己写了一份，措辞已经漂移）。 */}
      {slots.isPending ? (
        <SlotsLoading />
      ) : slots.isError ? (
        <SlotsError />
      ) : list.length === 0 ? (
        <NoSlots />
      ) : (
        <div className={styles.columns}>
          {/* 左列：餐槽时间轴。按天分组，每天一个日头 + 该天的午/晚两格 */}
          <div className={styles.timeline} data-testid="slot-timeline">
            {groupByDate(list).map(([date, daySlots]) => (
              <div key={date} className={styles.dayGroup} data-testid={`timeline-day-${date}`}>
                <div className={styles.dayHead}>
                  <b>{dayLabel(daySlots[0]!, today)}</b>
                  <span className="sub">{weekdayOf(date)}</span>
                </div>
                {daySlots.map((slot) => {
                  const isOn = selected?.id === slot.id;
                  const decided = slot.status === 'decided';
                  return (
                    <button
                      key={slot.id}
                      type="button"
                      className={isOn ? `${styles.slotCard} ${styles.slotOn}` : styles.slotCard}
                      data-testid={`timeline-slot-${slot.id}`}
                      data-slot-id={slot.id}
                      aria-pressed={isOn}
                      onClick={() => setSelectedId(slot.id)}
                    >
                      <span className={styles.slotTop}>
                        <b>{slot.meal === 'lunch' ? '午餐' : '晚餐'}</b>
                        <span className={decided ? 'badge ok' : 'badge'}>{decided ? '已定' : '未定'}</span>
                      </span>
                      {/* 摘要（story 23）：菜名预告，不用逐张点开也知道这一餐定了什么 */}
                      <span className="sub" data-testid={`timeline-summary-${slot.id}`}>
                        {summarize(slot)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 右列：选中那一餐的详情——就是手机版大卡那个组件，操作与 testid 全都不变 */}
          <div className={styles.detail}>
            {selected ? (
              <HeroCard
                key={selected.id}
                slot={selected}
                today={today}
                feedback={feedback.data?.feedback}
                cooling={feedback.data?.cooling ?? []}
              />
            ) : null}
          </div>
        </div>
      )}

      <HealthFooter />
    </div>
  );
}

/** 餐槽卡上的一行摘要：已定列菜名（多的话报总数），未定说一句实情 */
function summarize(slot: SlotWithPortion): string {
  const dishes = slot.menu?.dishes ?? [];
  if (slot.status !== 'decided' || dishes.length === 0) return '还没定';
  const names = dishes.slice(0, 3).map((dish) => dish.name);
  const tail = dishes.length > names.length ? ` 等 ${dishes.length} 道` : '';
  return names.join('、') + tail;
}

/** 按日期分组（列表本身已按日期 × 餐次排好，这里只分组、不重排——与 B 视图同一口径） */
function groupByDate<T extends { date: string }>(slots: T[]): [string, T[]][] {
  const days = new Map<string, T[]>();
  for (const slot of slots) {
    const list = days.get(slot.date);
    if (list) list.push(slot);
    else days.set(slot.date, [slot]);
  }
  return [...days.entries()];
}

