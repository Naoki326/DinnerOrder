import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import {
  groupByCategory,
  manualItems,
  useAddManualItem,
  useArchiveGrocery,
  useCheckItem,
  useDeleteManualItem,
  useGrocery,
  useRecalculateGrocery,
  type GroceryItem,
  type GroceryList,
  type GroceryStaleReason,
} from '../api/grocery';
import styles from './GroceryView.module.css';

/**
 * 买菜清单（S8、总纲 §2.7）——掌勺者一张单走菜场。形态照原型 v1，不再打磨。
 *
 * 页面自上而下，顺序就是掌勺者的动线：
 *   1. **过期警告**（改过餐才有）：「⚠️ （原因），清单过期了」+「重算」——原因要说得出是哪一餐；
 *   2. **清单卡**（有聚合行时才在）：标题旁「归档」；聚合行按分类分组；行内 = 勾选 + 食材名 +
 *      生重合计（≥500 g 另给斤）+ 来源（来自哪几餐的哪道菜）+ 待重算标记；
 *   3. 卡底一句**生熟换算参考**（数字从互换表现算，不由前端硬编码）；
 *   4. **手工行**一张卡**恒在**（照原型 v1）：不属任何菜谱、重算保留，可加可勾可删。
 *      恒在不只是形态：一餐都没定时它是唯一能写东西的地方，而且手工行会**把清单建起来**
 *      （服务端「读页面时不凭空造空清单、动手写时才建」，见 domain/grocery.ts）。
 *   5. 归档过几份看得见（「买完归档」是常态动作，要能看见它真的存下来了）。
 *
 * 手机宽度纪律（390×844）：窄屏下所有可伸缩的文字都允许换行，长的来源说明不撑破卡片。
 * 没有聚合行也是正常状态：没定过餐、或刚归档完，清单就应该是空的（不凭空造一张空的）。
 */
export function GroceryView() {
  const grocery = useGrocery();
  const recalculate = useRecalculateGrocery();
  const archive = useArchiveGrocery();
  const addManual = useAddManualItem();
  const check = useCheckItem();
  const removeManual = useDeleteManualItem();
  const [draft, setDraft] = useState('');
  // 上一个动作的结果（成功一句话 / 失败一句人话）。每次动作前清掉：手机上一串越积越长的
  // 提示条既占地方又会把「刚才那一下到底成没成」搅浑。
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const actions = [recalculate, archive, addManual, check, removeManual];
  const pending = actions.some((action) => action.isPending);

  const list = grocery.data?.list ?? null;
  const today = grocery.data?.today ?? '';
  const archivedCount = grocery.data?.archivedCount ?? 0;

  /**
   * 跑一次会改清单的动作。五处按钮共用这一处，是因为三件事对它们都一样：
   *   * **清掉上一条结果**：五个 mutation 的错误都显示在同一处，不清就会「上一次失败」
   *     和「这一次成功」同时挂在屏幕上；
   *   * **成败都翻成一句人话**：成功说清这一步做了什么（重算继承了勾选、归档封存了），
   *     失败直接把服务端那句翻好的话摆出来（`readGroceryError`），不吞成「出错了」；
   *   * **串行**：`pending` 期间全部按钮禁用——清单的四个动作都会改写同一份物化数据，
   *     手机上连点两下重算 / 边勾边重算的中间态没有意义。
   */
  function act<TInput>(
    mutation: UseMutationResult<GroceryList, Error, TInput, unknown>,
    input: TInput,
    done: string,
    after?: () => void,
  ): void {
    for (const action of actions) action.reset();
    setFeedback(null);
    mutation.mutate(input, {
      onSuccess: () => {
        setFeedback({ ok: true, text: done });
        after?.();
      },
      onError: (cause) => setFeedback({ ok: false, text: cause.message }),
    });
  }

  if (grocery.isPending) {
    return (
      <div className="card sub" data-testid="grocery-loading">
        读取中…
      </div>
    );
  }
  if (grocery.isError) {
    return (
      <div className="card" data-testid="grocery-error">
        <b>买菜清单没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          {grocery.error instanceof Error ? grocery.error.message : '检查一下网络或服务是不是停了。'}
        </div>
      </div>
    );
  }

  function add(e: React.FormEvent): void {
    e.preventDefault();
    const name = draft.trim();
    if (name === '') return;
    // 没定过餐时，这一下会在服务端把一张空清单建起来（掌勺者要往清单里放东西就该有清单接着），
    // 而响应里带着整份新清单——所以 `useAddManualItem` 把它写进缓存，清单卡随之出现。
    act(addManual, name, `已加进清单：${name}`, () => setDraft(''));
  }

  return (
    <div data-testid="grocery-view">
      {list === null ? (
        <div className="card" data-testid="grocery-empty">
          <div className="spread">
            <b>买菜清单</b>
            {archivedCount > 0 ? (
              <span className="badge" data-testid="grocery-archived-count">
                已归档 {archivedCount} 份
              </span>
            ) : null}
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            现在没有要买的东西：定下几餐之后，这一页会把要买的食材按生重合计出来。
            {archivedCount > 0 ? '上一份已经归档（菜单没变，就不再重复开一张）。' : ''}
          </div>
        </div>
      ) : (
        <>
          {list.stale ? (
            <div className={`card ${styles.stale}`} data-testid="grocery-stale">
              <div className="spread">
                <span className={styles.staleText} data-testid="grocery-stale-reason">
                  ⚠️ {staleReasonText(list, today)}，清单过期了
                </span>
                <button
                  type="button"
                  className="btn small"
                  data-testid="grocery-recalculate"
                  disabled={pending}
                  onClick={() => act(recalculate, undefined, '清单已重算（勾选按食材继承、手工行保留）')}
                >
                  重算
                </button>
              </div>
              <div className="sub" style={{ marginTop: 6 }}>
                重算前是上一次的合计与勾选，先别照着买。
              </div>
            </div>
          ) : null}

          <div className="card" data-testid="grocery-list">
            <div className="spread">
              <b>
                买菜清单{' '}
                <span className="sub" data-testid="grocery-status">
                  进行中 · {list.mealCount} 餐
                </span>
              </b>
              <button
                type="button"
                className="btn ghost small"
                data-testid="grocery-archive"
                disabled={pending}
                onClick={() => act(archive, undefined, '清单已归档（这一趟买完了）')}
              >
                归档
              </button>
            </div>
            {/* 归档计数放标题下：归档后这张卡就没了，下一轮开始时仍要能看见“上一份买完了” */}
            {archivedCount > 0 ? (
              <div className="sub" data-testid="grocery-archived-count">
                已归档 {archivedCount} 份
              </div>
            ) : null}

            {list.items.every((item) => item.kind !== 'aggregate') ? (
              <div className="sub" data-testid="grocery-no-aggregate" style={{ marginTop: 8 }}>
                还没有已定的餐要买——下面的手工行是掌勺者自己加的。
              </div>
            ) : (
              groupByCategory(list.items).map((group) => (
                <div key={group.category} className={styles.group} data-testid={`grocery-group-${group.category}`}>
                  <div className="sub">{group.category}</div>
                  {group.items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      today={today}
                      pending={pending}
                      onToggle={(checked) => act(check, { itemId: item.id, checked }, checked ? `买到了：${item.name}` : `取消勾选：${item.name}`)}
                    />
                  ))}
                </div>
              ))
            )}

            {/* 生熟换算参考（原型 v1 的一句话位置）：数字从互换表现算，图表改了这里跟着变 */}
            <div className="sub" data-testid="grocery-exchange-note" style={{ marginTop: 10 }}>
              {list.exchangeNote}（生熟换算参考）
            </div>
          </div>

          <div className="card sub" data-testid="grocery-summary">
            勾一行是买到了，⌛ 待重算是「这个食材在菜里、克数还没定」。
          </div>
        </>
      )}

      {/* 手工行恒在（照原型 v1）：一餐都没定时，这里是唯一能写东西的地方 */}
      <div className="card" data-testid="grocery-manual">
        <b>
          手工行 <span className="sub">不属于任何菜谱，重算时保留</span>
        </b>
        {manualItems(list?.items ?? []).map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            today={today}
            pending={pending}
            onToggle={(checked) => act(check, { itemId: item.id, checked }, checked ? `买到了：${item.name}` : `取消勾选：${item.name}`)}
            onDelete={() => act(removeManual, item.id, `已删掉手工行：${item.name}`)}
          />
        ))}
        <form className={styles.addRow} onSubmit={add}>
          <input
            type="text"
            className={styles.input}
            data-testid="grocery-manual-input"
            placeholder="临时要买的…"
            value={draft}
            maxLength={50}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn ghost small" data-testid="grocery-manual-add" disabled={pending}>
            加
          </button>
        </form>
      </div>

      {feedback !== null ? (
        <div className="card" data-testid={feedback.ok ? 'grocery-notice' : 'grocery-action-error'}>
          {feedback.ok ? (
            <span className="sub">{feedback.text}</span>
          ) : (
            <>
              <b>这一步没成功</b>
              <div className="sub" style={{ marginTop: 6 }}>
                {feedback.text}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 过期警告卡上那句原因：`staleReason` 是**枚举**（服务端不再存渲染好的中文，见 #23 评审修复 ②），
 * 这里把「哪一餐 + 哪种改法」现拼成一句人话。
 *
 * 两个形状：
 *   * 槽位类（菜单变了 / 取消了 / 换回上一套了）——主语是 `staleSlotId` 那一餐；
 *   * `family_rules_changed`——没有具体哪一餐（改的是家规：留量上浮改了克数、截止时刻改了哪几餐该买），
 *     所以那句话自己说完整，不再去凑一个槽。
 *
 * 相对叫法（「今天午餐」）只在**渲染那一刻**算，所以不会像存中文那样随时间漂移；
 * 这一处与来源行的 `mealLabel` 共用同一套「今天/明天 + 午/晚餐」口径（今天来自服务端 `today`）。
 */
function staleReasonText(list: GroceryList, today: string): string {
  const reason = list.staleReason;
  // 只在 `list.stale` 时渲染，而 schema 上过期必有原因；这一支兜的是手改库（宁可话说粗一点，也别整页打不开）
  if (reason === null) return '菜单变了';
  if (reason === 'family_rules_changed') return '家规改了（留量或餐次截止时刻变了）';
  // 槽位类原因必须带槽（服务端 schema 上成对）：拿不到就只说改法，不编造是哪一餐
  if (list.staleSlotId === null) return staleTail[reason];
  return `${mealLabel(list.staleSlotId.slice(0, 10), mealOf(list.staleSlotId), today)}${staleTail[reason]}`;
}

/** 过期原因的后半截：「今天午餐」+ 这里的尾巴 */
const staleTail: Record<Exclude<GroceryStaleReason, 'family_rules_changed'>, string> = {
  menu_changed: '的菜单变了',
  cancelled: '取消了',
  set_undone: '换回上一套了',
};

/** 槽 id 的餐次部分（'YYYY-MM-DD:lunch|dinner'）；形状不合法就当一个默认值，界面照常读得出来 */
function mealOf(slotId: string): 'lunch' | 'dinner' {
  return slotId.endsWith(':dinner') ? 'dinner' : 'lunch';
}

/**
 * 一条行（聚合行与手工行共用）：勾选 + 名字 + 克数 + 来源。
 *
 * 克数照原型 v1 的读法：≥500 g 另给「斤」（菜场上论斤问价），但**生重克数照旧写出来**
 * ——换算过的数不该取代原值。来源那句说明这一份食材是哪几顿饭吃出来的。
 */
function ItemRow({
  item,
  today,
  pending,
  onToggle,
  onDelete,
}: {
  item: GroceryItem;
  today: string;
  pending: boolean;
  onToggle: (checked: boolean) => void;
  onDelete?: () => void;
}) {
  const checked = item.checked;
  return (
    <div className={styles.row} data-testid={`grocery-item-${item.id}`}>
      <button
        type="button"
        className={styles.check}
        data-testid={`grocery-check-${item.id}`}
        aria-pressed={checked}
        aria-label={checked ? `取消勾选 ${item.name}` : `勾选 ${item.name}`}
        disabled={pending}
        onClick={() => onToggle(!checked)}
      >
        {checked ? '✅' : '⬜'}
      </button>
      <div className={styles.body}>
        <div className={checked ? styles.done : undefined}>
          <b data-testid={`grocery-name-${item.id}`}>{item.name}</b>
          {item.kind === 'aggregate' && item.grams !== null ? (
            <span className="sub" data-testid={`grocery-grams-${item.id}`}>
              {' '}
              {item.grams >= 500 ? `${Math.round((item.grams / 500) * 10) / 10} 斤（${item.grams} g）` : `${item.grams} g`}
            </span>
          ) : null}
          {item.needsRelabel ? (
            <span className="badge warn" data-testid={`grocery-relabel-${item.id}`}>
              ⌛ 待重算
            </span>
          ) : null}
        </div>
        {item.kind === 'aggregate' && item.sources.length > 0 ? (
          <div className="sub" data-testid={`grocery-sources-${item.id}`}>
            来自 {item.sources.length} 道菜：{item.sources.map((source) => `${mealLabel(source.date, source.meal, today)}·${source.recipeName}`).join('；')}
          </div>
        ) : null}
      </div>
      {onDelete ? (
        <button type="button" className="btn ghost small" data-testid={`grocery-delete-${item.id}`} onClick={onDelete}>
          删
        </button>
      ) : null}
    </div>
  );
}

/**
 * 「今天午餐 / 明天晚餐 / 06-03 午餐」：显示层唯一的一处（#23 评审修复 ③）。
 *
 * 曾经它与服务端 `slotLabel` 是同口径的两份；现在服务端只下发结构（来源的 date/meal、
 * 过期原因的 `staleSlotId`），中文全在这里拼——两份变一份。这个函数两处用：
 *   * 聚合行的来源（「来自 2 道菜：明天午餐·红烧排骨」）；
 *   * 过期警告的主语（「今天午餐的菜单变了」）。
 * 相对叫法只在渲染时算，`today` 是服务端下发的家庭时区今天（不用浏览器本地日期）。
 */
function mealLabel(date: string, meal: 'lunch' | 'dinner', today: string): string {
  const prefix = date === today ? '今天' : date === tomorrow(today) ? '明天' : date.slice(5);
  return `${prefix}${meal === 'lunch' ? '午餐' : '晚餐'}`;
}

function tomorrow(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
