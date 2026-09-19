import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useIdentity } from '../identity';
import { useRecipes, type Recipe } from '../api/recipes';
import { useBookSlot, useCancelSlot, useSlot, type MealEvent, type MealSlot } from '../api/meals';
import styles from './SlotView.module.css';

/**
 * 定餐编辑器（总纲 §2.1「定餐 = 换菜，同一编辑器」）。
 *
 * 一屏里三件事：挑菜（按荤/素/汤分组，点一下加/减）、改用餐者名单（默认全员，可临时改）、
 * 保存为已定 / 取消。菜单是**整份提交**的：服务端把每次提交记成一条留痕事件，
 * 前端不做「加一道菜就发一次接口」的增量同步——半份状态就有地方藏。
 *
 * 下面还列着这一餐的留痕（append-only）：改过什么、什么时候改的，翻历史看得到。
 */
export function SlotView() {
  const { slotId } = useParams<{ slotId: string }>();
  const slotQuery = useSlot(slotId);
  const recipesQuery = useRecipes('all');

  if (slotQuery.isPending || recipesQuery.isPending) {
    return (
      <div className="card sub" data-testid="slot-loading">
        读取中…
      </div>
    );
  }
  if (slotQuery.isError || !slotQuery.data) {
    return (
      <div className="card" data-testid="slot-error">
        <b>这一餐没读回来</b>
        <div className="sub" style={{ marginTop: 6 }}>
          {slotQuery.error instanceof Error ? slotQuery.error.message : '检查一下地址或服务'}
        </div>
        <div style={{ marginTop: 10 }}>
          <Link className="btn ghost" to="/">
            回首页
          </Link>
        </div>
      </div>
    );
  }

  // 数据到位后才挂载编辑器：hooks 不必为「还没数据」的空态分叉
  return <SlotEditor slot={slotQuery.data.slot} history={slotQuery.data.history} recipes={recipesQuery.data ?? []} />;
}

interface DraftDish {
  recipeId: string;
  keepLeftover: boolean;
}

function SlotEditor({ slot, history, recipes }: { slot: MealSlot; history: MealEvent[]; recipes: Recipe[] }) {
  const navigate = useNavigate();
  const { members } = useIdentity();
  const book = useBookSlot();
  const cancel = useCancelSlot();
  const [error, setError] = useState<string | undefined>(undefined);

  // 本地草稿：编辑期间不动服务端，一次提交才是「菜单变了」的那个瞬间
  const [dinersDraft, setDinersDraft] = useState<string[] | null>(null);
  const [dishes, setDishes] = useState<DraftDish[]>(
    () => slot.menu?.dishes.map((dish) => ({ recipeId: dish.recipeId, keepLeftover: dish.keepLeftover })) ?? [],
  );

  // 首次定餐的默认用餐者是**全员**（总纲 §3）；家人列表可能晚于餐槽到位，所以默认值现算而不是初值快照
  const diners = dinersDraft ?? (slot.menu ? slot.menu.diners.map((diner) => diner.memberId) : members.map((m) => m.id));

  const byId = useMemo(() => new Map(recipes.map((recipe) => [recipe.id, recipe])), [recipes]);
  const chosen = useMemo(() => new Set(dishes.map((dish) => dish.recipeId)), [dishes]);
  const pool = useMemo(() => sortForBooking(recipes), [recipes]);

  const toggleDiner = (memberId: string): void => {
    setDinersDraft(diners.includes(memberId) ? diners.filter((id) => id !== memberId) : [...diners, memberId]);
  };

  const toggleDish = (recipeId: string): void => {
    setDishes((current) =>
      current.some((dish) => dish.recipeId === recipeId)
        ? current.filter((dish) => dish.recipeId !== recipeId)
        : [...current, { recipeId, keepLeftover: false }],
    );
  };

  const toggleKeep = (recipeId: string): void => {
    setDishes((current) =>
      current.map((dish) => (dish.recipeId === recipeId ? { ...dish, keepLeftover: !dish.keepLeftover } : dish)),
    );
  };

  const save = (): void => {
    setError(undefined);
    book.mutate(
      { slotId: slot.id, booking: { diners, dishes, source: 'manual' } },
      {
        onSuccess: () => navigate('/'),
        onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败'),
      },
    );
  };

  const doCancel = (): void => {
    setError(undefined);
    cancel.mutate(slot.id, {
      onSuccess: () => navigate('/'),
      onError: (cause) => setError(cause instanceof Error ? cause.message : '取消失败'),
    });
  };

  const decided = slot.status === 'decided';

  return (
    <div data-testid="slot-view" data-slot-id={slot.id}>
      <div className={`card ${styles.head}`}>
        <div className="spread">
          <div>
            <div className={styles.title}>
              {slot.date} · {slot.meal === 'lunch' ? '午餐' : '晚餐'}
            </div>
            <div className="sub">{slot.editable ? (decided ? '已定，可改可取消' : '未定') : '这一餐已经过了，只能看'}</div>
          </div>
          <span className={decided ? 'badge ok' : 'badge'} data-testid="slot-status">
            {decided ? '已定' : '未定'}
          </span>
        </div>
      </div>

      {/* 用餐者名单：默认全员，可临时改（忌口、份量都按它算） */}
      <div className="card">
        <div className={styles.blockLabel}>这餐谁吃（忌口与份量按它算）</div>
        <div className={styles.diners} data-testid="diner-picker">
          {members.map((member) => {
            const on = diners.includes(member.id);
            return (
              <button
                key={member.id}
                type="button"
                className={on ? `${styles.diner} ${styles.on}` : styles.diner}
                data-testid={`diner-${member.id}`}
                aria-pressed={on}
                onClick={() => toggleDiner(member.id)}
              >
                {member.emoji} {member.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 已选的菜 */}
      <div className="card">
        <div className={styles.blockLabel}>这一餐的菜（{dishes.length} 道）</div>
        {dishes.length === 0 ? (
          <div className="sub" data-testid="no-dishes">
            还没挑菜——下面点一下就加进来。
          </div>
        ) : (
          <div className={styles.chosen} data-testid="chosen-dishes">
            {dishes.map((dish) => {
              const recipe = byId.get(dish.recipeId);
              if (!recipe) return null;
              return (
                <div key={dish.recipeId} className={styles.chosenRow} data-testid={`chosen-${dish.recipeId}`}>
                  <span className={`${styles.kind} ${styles[recipe.kind]}`}>{KIND_LABEL[recipe.kind]}</span>
                  <span className={styles.chosenName}>{recipe.name}</span>
                  <button
                    type="button"
                    className={dish.keepLeftover ? `${styles.keep} ${styles.keepOn}` : styles.keep}
                    data-testid={`keep-${dish.recipeId}`}
                    aria-pressed={dish.keepLeftover}
                    onClick={() => toggleKeep(dish.recipeId)}
                  >
                    留量
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    aria-label={`去掉 ${recipe.name}`}
                    data-testid={`remove-${dish.recipeId}`}
                    onClick={() => toggleDish(dish.recipeId)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 挑菜：按荤/素/汤分组 */}
      <div className="card">
        <div className={styles.blockLabel}>加菜（点一下加，再点一下去掉）</div>
        {(['meat', 'veg', 'soup_meat', 'soup_veg'] as const).map((kind) => {
          const group = pool.filter((recipe) => recipe.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className={styles.group}>
              <div className={styles.groupLabel}>{GROUP_LABEL[kind]}</div>
              <div className={styles.picker}>
                {group.map((recipe) => (
                  <button
                    key={recipe.id}
                    type="button"
                    className={chosen.has(recipe.id) ? `${styles.pick} ${styles.picked}` : styles.pick}
                    data-testid={`pick-${recipe.id}`}
                    aria-pressed={chosen.has(recipe.id)}
                    onClick={() => toggleDish(recipe.id)}
                  >
                    {recipe.name}
                    {recipe.status === 'draft' ? <span className={styles.tiny}>没做过</span> : null}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {error ? (
        <div className="card" data-testid="slot-error-message">
          <span className={styles.error}>{error}</span>
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className="btn block"
          data-testid="save-slot"
          disabled={!slot.editable || book.isPending || dishes.length === 0 || diners.length === 0}
          onClick={save}
        >
          {book.isPending ? '保存中…' : decided ? '保存改动' : '定下这一餐'}
        </button>
        {decided ? (
          <button
            type="button"
            className="btn ghost block"
            data-testid="cancel-slot"
            disabled={cancel.isPending}
            onClick={doCancel}
          >
            {cancel.isPending ? '取消中…' : '取消这一餐'}
          </button>
        ) : null}
      </div>

      {/* 留痕（append-only）：这一餐怎么一步步变成现在这样的 */}
      <div className="card">
        <div className={styles.blockLabel}>这一餐的留痕（{history.length} 条，只增不改）</div>
        {history.length === 0 ? (
          <div className="sub" data-testid="history-empty">
            还没定过，改完保存就会有第一条。
          </div>
        ) : (
          <ol className={styles.history} data-testid="slot-history">
            {history.map((event) => (
              <li key={event.seq} data-testid={`history-${event.type}`}>
                <span className={styles.eventType}>{EVENT_LABEL[event.type] ?? event.type}</span>{' '}
                <span className="sub">{eventAt(event.occurredAt)}</span>
                {event.dishes.length > 0 ? (
                  <div className="sub" data-testid={`history-${event.type}-dishes`}>
                    {event.dishes.map((dish) => dish.name).join('、')}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { meat: '荤', veg: '素', soup_meat: '汤', soup_veg: '汤' };
const GROUP_LABEL: Record<string, string> = { meat: '荤菜', veg: '素菜', soup_meat: '荤汤', soup_veg: '素汤' };
const EVENT_LABEL: Record<string, string> = {
  decide: '预定',
  replace: '改餐',
  replace_set: '换一整套',
  cancel: '取消',
};

/**
 * 挑菜的顺序：先按荤素汤位、再按名字，顺序稳定、不随请求回来的次序漂移。
 * 退役的菜不上挑菜器（家里不再做；要吃先转正），草稿留着——它是外部补位池的菜（spec S6）。
 */
function sortForBooking(recipes: Recipe[]): Recipe[] {
  const order: Record<string, number> = { meat: 0, veg: 1, soup_meat: 2, soup_veg: 3 };
  return recipes
    .filter((recipe) => recipe.status !== 'retired')
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name, 'zh'));
}

/** 事件的时刻：显示到分钟（家庭时区）——这是「家里什么时候定的」，不是技术时间戳 */
export function eventAt(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
