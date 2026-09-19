import { useState } from 'react';
import { Link } from 'react-router';
import { useCancelSlot, useSlots, type SlotWithPortion } from '../api/meals';
import { dayLabel } from './HomeView';
import styles from './CompactView.module.css';

/**
 * B 视图：掌勺者紧凑流（总纲 §2.10、原型变体 B）。
 *
 * 掌勺者要的是「这几天哪些餐定了、哪些还没定、定了什么」在一屏里扫完：按天分组的时间轴、
 * 每行一个餐槽、行头带餐次与菜单摘要（含留量的 🌙）、点行头**行内展开**详情——而不是像 A
 * 那样把后面的餐收成需要跳转的卡片。
 *
 * 与 A/C 是同一份数据与同一套操作语义（`useSlots` 同一条接口、编辑器同一个 `/slot/:id`、
 * 取消同一个 `DELETE /slots/:id`）；这里只是**换一种摆法**：
 *   * 展开后每道菜给本餐生重（`slot.portion` 列表接口内嵌，份量已随时钟现算）；
 *   * 「定一餐 / 改这餐」进的是与 A 完全相同的那一个编辑器；
 *   * 「取消」是同一语义的快捷入口（编辑器里的取消按钮不是唯一的路）。
 *
 * 不做的：不在这一屏里内联换菜候选（那是编辑器里的会话，原型也是跳编辑器）——
 * 三套视图共用同一个换菜界面，才不会出现「B 里换菜不累计排除」这种语义漂移。
 */
export function CompactView() {
  const slotsQuery = useSlots(3);
  const cancel = useCancelSlot();
  // 展开的行（默认全收起：紧凑流的价值就是「先扫一遍」，展开是第二步）
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const slots = slotsQuery.data?.slots ?? [];
  const today = slotsQuery.data?.today;

  if (slotsQuery.isPending) {
    return (
      <div className="card sub" data-testid="compact-view" data-state="loading">
        读取中…
      </div>
    );
  }
  if (slotsQuery.isError) {
    return (
      <div className="card" data-testid="compact-view" data-state="error">
        <b>日程没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          检查一下网络或服务是不是停了。
        </div>
      </div>
    );
  }

  // 按天分组（列表本身已按日期×餐次排好，这里只做分组、不重排）
  const days = new Map<string, SlotWithPortion[]>();
  for (const slot of slots) {
    const list = days.get(slot.date);
    if (list) list.push(slot);
    else days.set(slot.date, [slot]);
  }

  return (
    <div data-testid="compact-view">
      {days.size === 0 ? (
        <div className="card sub" data-testid="compact-empty">
          这几天没有要安排的餐了。
        </div>
      ) : null}

      {[...days.entries()].map(([date, daySlots]) => {
        const decided = daySlots.filter((slot) => slot.status === 'decided').length;
        return (
          <div key={date}>
            <div className={styles.dayHead} data-testid={`compact-day-${date}`}>
              <span>
                <b>{dayLabel(daySlots[0]!, today)}</b> <span className="sub">{weekdayOf(date)}</span>
              </span>
              <span className="sub">
                {decided}/{daySlots.length} 定
              </span>
            </div>
            {daySlots.map((slot) => (
              <SlotRow
                key={slot.id}
                slot={slot}
                today={today}
                open={open[slot.id] === true}
                onToggle={() => setOpen((current) => ({ ...current, [slot.id]: !current[slot.id] }))}
                onCancel={() => cancel.mutate(slot.id)}
                cancelling={cancel.isPending}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 一个餐槽一行：行头可点开，展开后是菜单/用餐者/份量与本行的动作 */
function SlotRow({
  slot,
  today,
  open,
  onToggle,
  onCancel,
  cancelling,
}: {
  slot: SlotWithPortion;
  today: string | undefined;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const decided = slot.status === 'decided';
  const dishes = slot.menu?.dishes ?? [];
  const diners = slot.menu?.diners ?? [];
  const totalGrams = slot.portion?.dishes.reduce((sum, dish) => sum + dish.totalGrams, 0) ?? 0;

  return (
    <div className={styles.slot} data-testid={`compact-slot-${slot.id}`}>
      {/* 行头：点它展开/收起。折叠时就给未定的行一个直达按钮（原型 b-slot 的「顶」）——
          掌勺者扫一遍日程就能直接顶一餐，不必先展开。 */}
      <div className={styles.head}>
        <button
          type="button"
          className={styles.headMain}
          data-testid={`compact-toggle-${slot.id}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <span
            className={decided ? `${styles.dot} ${styles.ok}` : `${styles.dot} ${styles.todo}`}
            aria-hidden="true"
          />
          <b className={styles.meal}>{slot.meal === 'lunch' ? '午餐' : '晚餐'}</b>
          <span className={styles.summary}>
            {dishes.length > 0 ? (
              dishes.map((dish) => (
                <span key={dish.recipeId} className={styles.miniDish}>
                  {dish.name}
                  {dish.keepLeftover ? '🌙' : ''}
                </span>
              ))
            ) : (
              <span className="sub">未定</span>
            )}
          </span>
          <span className="sub" aria-hidden="true">
            {open ? '▴' : '▾'}
          </span>
        </button>
        {decided ? null : (
          <Link className={styles.quick} to={`/slot/${slot.id}`} data-testid={`compact-book-${slot.id}`}>
            定
          </Link>
        )}
      </div>

      {open ? (
        <div className={styles.body} data-testid={`compact-body-${slot.id}`}>
          {dishes.length > 0 ? (
            <>
              <div className="sub">
                用餐者 {diners.map((diner) => `${diner.emoji}${diner.name}`).join(' ')}
              </div>
              <div className={styles.dishes}>
                {dishes.map((dish) => {
                  const portion = slot.portion?.dishes.find((item) => item.recipeId === dish.recipeId);
                  return (
                    <div
                      key={dish.recipeId}
                      className={styles.dishRow}
                      data-testid={`compact-dish-${slot.id}-${dish.recipeId}`}
                    >
                      <span className={`${styles.kind} ${styles[dish.kind]}`}>{KIND_LABEL[dish.kind]}</span>
                      <span className={styles.dishName}>{dish.name}</span>
                      {dish.keepLeftover ? <span className="badge">留量</span> : null}
                      {portion !== undefined ? (
                        <span className={styles.grams}>{portion.totalGrams} g</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {totalGrams > 0 ? <div className="sub">这一餐共 {totalGrams} g（生重）</div> : null}
            </>
          ) : (
            <div className="sub" data-testid={`compact-undecided-${slot.id}`}>
              {dayLabel(slot, today)}还没定 —— 想吃了就进去挑，不想吃就放着（app 不打扰）。
            </div>
          )}

          <div className={styles.actions}>
            <Link
              className="btn ghost"
              to={`/slot/${slot.id}`}
              data-testid={decided ? `compact-edit-${slot.id}` : `compact-book-body-${slot.id}`}
            >
              {decided ? '✏️ 改这餐' : '🍽 去定这一餐'}
            </Link>
            {decided ? (
              <button
                type="button"
                className="btn ghost"
                data-testid={`compact-cancel-${slot.id}`}
                disabled={cancelling}
                onClick={onCancel}
              >
                取消
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };

/**
 * 日头下的「周X M/D」。用 UTC 取星期，避免本地时区把 'YYYY-MM-DD' 解析成前一天
 * （服务端下发的日期是**家庭时区**的日历日期，本地时区往回退时 getDay 会给出错误的星期）。
 */
function weekdayOf(date: string): string {
  const weekday = '日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `周${weekday} ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}
