import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { Ingredient, IngredientConflict, IngredientContainsSuggestionRequest, IngredientEditRecord, IngredientRef, IngredientReferenceCount, IngredientReferenceKind } from '@dinnerorder/server/types';
import {
  IngredientWriteError,
  useAllIngredients,
  useContainsSuggestion,
  useCreateIngredient,
  useDeleteIngredient,
  useIngredientEdits,
  useIngredientReferences,
  useIngredients,
  usePatchIngredient,
} from '../api/ingredients';
import { aliasesForDisplay, parseAliases } from '../components/ingredientVocabulary';
import { SectionedLayout } from '../components/SectionedLayout';
import { useIdentity } from '../identity';
import { useLayout } from '../layout';
import styles from './IngredientDictionaryView.module.css';

/**
 * 食材字典页（issue #34/#35；ADR-0012）：设置里钻进来的**从属页面**（`/ingredients`），形态照抄菜谱库。
 *
 * 五条口径（改之前先读）：
 *   * **不占主导航**：壳用 `hideNav`，顶部一个「← 设置」返回——它是从设置钻进来的，不是第五个日常页。
 *   * **搜索是纯前端**（与 `RecipeLibraryView` / `DishPicker` 同一纪律）：`GET /ingredients`
 *     一次拿齐，规范名与别名都 `includes` 命中（家人说「西红柿」，字典里叫「番茄」）。零额外 API 契约。
 *   * **录入只有一个必填项**（ADR-0012「决定二」）：别名、时令月份、「含」指针都在同一张表单里、
 *     都可不填。不填时令 = 四季有售（不写月份行）。
 *   * **改（#35）走部分更新 + 台账**：详情卡上能改规范名、别名、时令月份、「含」指针；
 *     四个字段一个都没变时服务端报 409，界面把那句「这次提交没有任何改动」原样说出来，
 *     不假装成功。改名之后菜谱/买菜清单/忌口显示全跟着换说法（无名称快照，本页不做同步）。
 *   * **删只在零引用时给按钮**：有引用时给的是**说明**（被哪几类引用、各几条）而不是一个
 *     按下去必报 409 的按钮——与菜谱库对退役/草稿「把下一步说出来」的既有口径一致。
 *     判据从 `GET /ingredients/:id/references` 取，与 `DELETE` 是同一份领域判定。
 *
 * 词汇按 `CONTEXT.md`：用**录入食材 / 改食材 / 删食材**，不用「加食材」（那是菜谱行里的动作）、
 * 也不用「编辑食材」（CONTEXT 明写为 Avoid）。
 */
export function IngredientDictionaryView() {
  const { layout } = useLayout();
  const ingredients = useAllIngredients();
  const [query, setQuery] = useState('');
  /** 正在看哪一条（null = 在列表上） */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 正在录入一条新食材（null = 没在录）；字符串是预填的规范名（从「新建这个」带进来） */
  const [creating, setCreating] = useState<string | null>(null);

  const all = ingredients.data ?? [];
  const keyword = query.trim();

  const visible = useMemo(
    () => all.filter((ingredient) => matchKeyword(ingredient, keyword)).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [all, keyword],
  );

  const open = openId ? all.find((ingredient) => ingredient.id === openId) : undefined;

  /** 删掉一条后回到列表：详情关掉、搜索清空（列表本来就一直挂在下面） */
  const backToList = (): void => {
    setCreating(null);
    setOpenId(null);
    setQuery('');
  };

  // 详情卡只构造这一次：宽版塞进右列（`data-section`），窄版整页展示——两分支不再是两份拷贝。
  // `key` 钉住当前条目：切换选中时**重新挂载**（编辑态/确认态不会从上一條漏到下一條）。
  const detailCard = open ? (
    <IngredientDetailCard key={open.id} ingredient={open} onDeleted={backToList} onOpen={setOpenId} />
  ) : null;

  // 录入表单（issue #34 的主干动作）：整页一张表单，不占列表那一列——与菜谱库的「录入一道新菜」同形。
  if (creating !== null) {
    return (
      <div data-testid="ingredient-dictionary-view">
        <BackRow onBack={() => setCreating(null)} backLabel="← 食材字典" />
        <CreateIngredientCard
          initialName={creating}
          onCreated={(id) => {
            setCreating(null);
            setOpenId(id);
            setQuery('');
          }}
          onCancel={() => setCreating(null)}
        />
      </div>
    );
  }

  const detail = open ? (
    <div className="card" data-section="detail">
      <BackRow onBack={() => setOpenId(null)} backLabel="← 食材字典" />
      {detailCard}
    </div>
  ) : (
    <div className="card sub" data-testid="ingredient-detail-empty" data-section="detail">
      点左边任意一条食材，这里就是它的别名、时令与「含」指针；零引用的还能在这里删掉。
    </div>
  );

  if (open && layout !== 'wide') {
    return (
      <div data-testid="ingredient-dictionary-view">
        <BackRow onBack={() => setOpenId(null)} backLabel="← 食材字典" />
        {detailCard}
      </div>
    );
  }

  return (
    /* 平板版（#31）：列表在左、选中的那一条在右（窄版仍是单列） */
    <SectionedLayout sideSection="detail" testId="ingredient-dictionary-view">
      {layout === 'wide' ? detail : null}
      <BackRow onBack={undefined} backLabel="← 设置" />

      <div className="card">
        <div className="spread">
          <b>食材字典</b>
          <span className="badge">{all.length} 条</span>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>
          全库唯一的受控食材表：菜谱食材、忌口、爱吃、买菜清单都指向这里。
        </div>
        <button
          type="button"
          className="btn block"
          style={{ marginTop: 10 }}
          data-testid="ingredient-create-open"
          onClick={() => setCreating('')}
        >
          ＋ 录入一条新食材
        </button>
      </div>

      <div className="card" data-testid="ingredient-list">
        <input
          className={styles.search}
          type="text"
          value={query}
          placeholder="搜食材（规范名或别名，如 西红柿）"
          aria-label="搜食材"
          autoComplete="off"
          enterKeyHint="search"
          data-testid="ingredient-search-input"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className={styles.summary}>
          <span className="sub" data-testid="ingredient-count">
            {visible.length} 条
          </span>
          <span className="sub">点一条看别名 / 时令 / 「含」</span>
        </div>

        {visible.length === 0 ? (
          <IngredientNotFound
            keyword={keyword}
            onCreate={() => setCreating(keyword)}
          />
        ) : (
          visible.map((ingredient) => (
            <IngredientRow
              key={ingredient.id}
              ingredient={ingredient}
              onOpen={() => setOpenId(ingredient.id)}
            />
          ))
        )}
      </div>
    </SectionedLayout>
  );
}

/** 顶部返回行。`onBack` 为空时是「← 设置」的链接（列表页），有值时是「← 食材字典」（详情/录入页）。 */
function BackRow({ onBack, backLabel }: { onBack: (() => void) | undefined; backLabel: string }) {
  return (
    <div className={styles.backRow}>
      {onBack ? (
        <button type="button" className={styles.back} data-testid="ingredient-back" onClick={onBack}>
          {backLabel}
        </button>
      ) : (
        // 设置是弹层不是路由（见 `SettingsSheet` 的 hash 说明）：`/#settings` 回到首页并自动把面板摆开
        <Link className={styles.back} data-testid="ingredient-back-settings" to="/#settings">
          {backLabel}
        </Link>
      )}
    </div>
  );
}

/** 搜不到时不是死路：给一句说明 + 一个**带着当前输入**的新建入口（ADR-0012 的卡点所在） */
function IngredientNotFound({ keyword, onCreate }: { keyword: string; onCreate: () => void }) {
  return (
    <div data-testid="ingredient-empty">
      <div className={styles.empty}>
        {keyword === '' ? '字典里还没有食材。' : '没有名字或别名对得上的食材——字典里就是没有这一条。'}
      </div>
      {keyword !== '' ? (
        <button
          type="button"
          className="btn block"
          style={{ marginTop: 8 }}
          data-testid="ingredient-create-for-query"
          onClick={onCreate}
        >
          ＋ 新建「{keyword}」
        </button>
      ) : null}
    </div>
  );
}

/** 列表里的一行：规范名 + 别名/时令小字 + 打开详情 */
function IngredientRow({ ingredient, onOpen }: { ingredient: Ingredient; onOpen: () => void }) {
  const aliases = aliasesForDisplay(ingredient);
  return (
    <button
      type="button"
      className={styles.row}
      data-testid={`ingredient-row-${ingredient.id}`}
      onClick={onOpen}
    >
      <span className={styles.rowMain}>
        <span className={styles.name} data-testid={`ingredient-name-${ingredient.id}`}>
          {ingredient.name}
        </span>
        <span className={styles.meta}>
          {aliases.length > 0 ? `别名：${aliases.join('、')}` : ''}
          {aliases.length > 0 && ingredient.seasonMonths.length > 0 ? ' · ' : ''}
          {seasonLabel(ingredient.seasonMonths)}
        </span>
      </span>
      <span className={styles.rowAction}>详情</span>
    </button>
  );
}

/**
 * 详情卡：别名 / 时令 / 「含」指针 + **改食材**（#35）+ 改动台账 + 删食材。
 *
 * 默认是只读的展示；点「改食材」才切到编辑表单（四个字段都可改，整体提交）。这样既保留了
 * 「看一眼就知道它是什么」的只读态，又不让一个常驻的表单把详情卡撑得难看。
 *
 * **零引用才给删除按钮**；有引用时给说明（被哪几类引用、各几条）——「只能改名」是下一步，
 * 现在这句话真的可做了（改食材）。
 */
function IngredientDetailCard({
  ingredient,
  onDeleted,
  onOpen,
}: {
  ingredient: Ingredient;
  onDeleted: () => void;
  onOpen: (id: string) => void;
}) {
  const references = useIngredientReferences(ingredient.id);
  const edits = useIngredientEdits(ingredient.id);
  const remove = useDeleteIngredient();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const aliases = aliasesForDisplay(ingredient);
  const refs = references.data;

  const doDelete = async (): Promise<void> => {
    setError(null);
    try {
      await remove.mutateAsync(ingredient.id);
      onDeleted();
    } catch (err) {
      // 理论上不会发生（按钮只在零引用时出现）；真发生了把服务端的话原样说出来
      setError(err instanceof Error ? err.message : '删除没成功');
    }
  };

  // 编辑态：整张详情卡换成表单（取消回到只读态）
  if (editing) {
    return (
      <div data-testid={`ingredient-detail-${ingredient.id}`}>
        <EditIngredientForm
          ingredient={ingredient}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div data-testid={`ingredient-detail-${ingredient.id}`}>
      <div className="spread">
        <b data-testid={`ingredient-detail-name-${ingredient.id}`}>{ingredient.name}</b>
        <span className="badge">{ingredient.seasonMonths.length > 0 ? '有季' : '四季有售'}</span>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>别名（家人怎么说）</span>
        {aliases.length > 0 ? (
          <div className={styles.chips} data-testid={`ingredient-aliases-${ingredient.id}`}>
            {aliases.map((alias) => (
              <span key={alias} className={styles.chip}>
                {alias}
              </span>
            ))}
          </div>
        ) : (
          <span className="sub" data-testid={`ingredient-aliases-${ingredient.id}`}>
            还没有别名
          </span>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>时令月份</span>
        <span className="sub" data-testid={`ingredient-season-${ingredient.id}`}>
          {seasonLabel(ingredient.seasonMonths)}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>隐性忌口「含」</span>
        {ingredient.contains.length > 0 ? (
          <div className={styles.chips} data-testid={`ingredient-contains-${ingredient.id}`}>
            {ingredient.contains.map((target) => (
              <button
                key={target.ingredientId}
                type="button"
                className={styles.chip}
                data-testid={`ingredient-contains-ref-${target.ingredientId}`}
                onClick={() => onOpen(target.ingredientId)}
              >
                {target.name}
              </button>
            ))}
          </div>
        ) : (
          <span className="sub" data-testid={`ingredient-contains-${ingredient.id}`}>
            没有挂「含」指针
          </span>
        )}
      </div>

      {/* 改食材（#35）：改规范名 / 别名 / 时令 / 「含」，每次改留一笔台账 */}
      <div className={styles.field}>
        <span className={styles.label}>改食材</span>
        <button
          type="button"
          className={`${styles.rowAction} ${styles.rowActionOpen}`}
          data-testid={`ingredient-edit-open-${ingredient.id}`}
          onClick={() => setEditing(true)}
        >
          改这条食材
        </button>
      </div>

      <IngredientHistory ingredientId={ingredient.id} edits={edits.data ?? []} pending={edits.isPending} />

      <div className={styles.field}>
        <span className={styles.label}>删除</span>
        {references.isPending ? (
          <span className="sub">读取引用中…</span>
        ) : references.isError ? (
          <span className="sub">引用读取失败——刷新一下页面再试。</span>
        ) : refs && refs.length === 0 ? (
          confirming ? (
            <div className={styles.actions}>
              <button
                type="button"
                className="btn"
                data-testid={`ingredient-delete-confirm-${ingredient.id}`}
                disabled={remove.isPending}
                onClick={() => void doDelete()}
              >
                确定删掉「{ingredient.name}」
              </button>
              <button
                type="button"
                className="btn ghost"
                data-testid={`ingredient-delete-cancel-${ingredient.id}`}
                disabled={remove.isPending}
                onClick={() => setConfirming(false)}
              >
                不删了
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.rowAction}
              data-testid={`ingredient-delete-${ingredient.id}`}
              onClick={() => setConfirming(true)}
            >
              删除这条食材
            </button>
          )
        ) : (
          // 有引用：给说明而不是一个按下去必报 409 的按钮（下一步是「改食材」）
          <div className={styles.conflict} data-testid={`ingredient-referenced-${ingredient.id}`}>
            还有地方在用它（{referenceSummary(refs ?? [])}），不能删——有引用的食材只能改名。
          </div>
        )}
      </div>

      {error ? (
        <div className={styles.error} data-testid={`ingredient-error-${ingredient.id}`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 改食材表单（issue #35）：四个字段都可改，提交时整体送给 `PATCH /ingredients/:id`。
 *
 * 与录入表单同形，但预填当前值、且**每个字段都可以是「没动」**——四个都没动时服务端报 409
 * `no_changes`，这里把那句话原样显示（不假装成功，也不写空台账）。
 * 改名撞了别人 → 409 `ingredient_conflict`，显示冲突对象与「用那条」以外的下一步（改个名再试）。
 */
function EditIngredientForm({
  ingredient,
  onSaved,
  onCancel,
}: {
  ingredient: Ingredient;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { current } = useIdentity();
  const [name, setName] = useState(ingredient.name);
  const [aliasesText, setAliasesText] = useState(ingredient.aliases.join('、'));
  const [months, setMonths] = useState<number[]>([...ingredient.seasonMonths]);
  // 「含」目标只存 id + 规范名（不需要完整的 Ingredient 形状）：预填现指针 + 搜索挑新的
  const [contains, setContains] = useState<ContainsTarget[]>(
    ingredient.contains.map((target) => ({ id: target.ingredientId, name: target.name })),
  );
  const [containsQuery, setContainsQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<IngredientConflict | null>(null);
  const patch = usePatchIngredient();

  const candidates = (useIngredients(containsQuery).data ?? [])
    .filter((option) => option.id !== ingredient.id && !contains.some((selected) => selected.id === option.id))
    .slice(0, 6)
    .map((option) => ({ id: option.id, name: option.name }));

  const submit = async (): Promise<void> => {
    setError(null);
    setConflict(null);
    try {
      await patch.mutateAsync({
        id: ingredient.id,
        input: {
          name,
          aliases: parseAliases(aliasesText),
          seasonMonths: months,
          contains: contains.map((item) => item.id),
          ...(current ? { memberId: current.id } : {}),
        },
      });
      onSaved();
    } catch (err) {
      if (err instanceof IngredientWriteError && err.code === 'ingredient_conflict' && err.conflict) {
        setConflict(err.conflict);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('保存没成功');
      }
    }
  };

  return (
    <div data-testid={`ingredient-editor-${ingredient.id}`}>
      <div className="spread">
        <b>改食材</b>
        <span className="sub">四个字段没变的话会提示「没有任何改动」</span>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>规范名（必填）</span>
        <input
          className={styles.input}
          type="text"
          value={name}
          placeholder="如 莴笋"
          aria-label="食材规范名"
          data-testid={`ingredient-name-edit-${ingredient.id}`}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>别名（用逗号或顿号分开；留空 = 没有别名）</span>
        <input
          className={styles.input}
          type="text"
          value={aliasesText}
          placeholder="如 青笋、莴苣笋"
          aria-label="食材别名"
          data-testid={`ingredient-aliases-edit-${ingredient.id}`}
          onChange={(event) => setAliasesText(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>时令月份（一个都不选 = 四季有售）</span>
        <div className={styles.months}>
          {MONTHS.map((month) => {
            const on = months.includes(month);
            return (
              <button
                key={month}
                type="button"
                className={on ? `${styles.month} ${styles.monthOn}` : styles.month}
                aria-pressed={on}
                data-testid={`ingredient-month-edit-${ingredient.id}-${month}`}
                onClick={() =>
                  setMonths((current) =>
                    current.includes(month) ? current.filter((item) => item !== month) : [...current, month].sort((a, b) => a - b),
                  )
                }
              >
                {month}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>隐性忌口「含」（只能挑字典里现有的）</span>
        <input
          className={styles.input}
          type="text"
          value={containsQuery}
          placeholder="搜食材（如 贝类）"
          aria-label="搜「含」的目标"
          data-testid={`ingredient-contains-search-edit-${ingredient.id}`}
          onChange={(event) => setContainsQuery(event.target.value)}
        />
        {containsQuery.trim() !== '' && candidates.length > 0 ? (
          <div className={styles.suggestions}>
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={styles.suggestion}
                data-testid={`ingredient-contains-option-edit-${ingredient.id}-${candidate.id}`}
                onClick={() => {
                  setContains((current) => [...current, candidate]);
                  setContainsQuery('');
                }}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        ) : null}
        {contains.length > 0 ? (
          <div className={styles.chips}>
            {contains.map((target) => (
              <button
                key={target.id}
                type="button"
                className={styles.chip}
                aria-label={`去掉 ${target.name}`}
                data-testid={`ingredient-contains-chip-edit-${ingredient.id}-${target.id}`}
                onClick={() => setContains((current) => current.filter((item) => item.id !== target.id))}
              >
                {target.name} ✕
              </button>
            ))}
          </div>
        ) : null}
        <ContainsSuggestionBox
          request={{ id: ingredient.id }}
          selected={contains}
          onAdopt={(target) => setContains((current) => (current.some((item) => item.id === target.ingredientId) ? current : [...current, { id: target.ingredientId, name: target.name }]))}
          testId={`edit-${ingredient.id}`}
        />
      </div>

      {conflict ? (
        <div className={styles.conflict} data-testid={`ingredient-conflict-${ingredient.id}`}>
          「{conflict.name}」已经在字典里了——改个别的名字，或者去改那一条。
        </div>
      ) : null}

      {error ? (
        <div className={styles.error} data-testid={`ingredient-error-edit-${ingredient.id}`}>
          {error}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className="btn"
          data-testid={`ingredient-save-edit-${ingredient.id}`}
          disabled={patch.isPending}
          onClick={() => void submit()}
        >
          保存改动
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid={`ingredient-edit-cancel-${ingredient.id}`}
          disabled={patch.isPending}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 改动台账（#35）：谁、什么时候、改了什么。只读，由服务端在每次改食材时写入。
 * 与 `RecipeEditor` 的修改历史同一形态（那边是菜谱，这边是食材）。
 */
function IngredientHistory({
  ingredientId,
  edits,
  pending,
}: {
  ingredientId: string;
  edits: IngredientEditRecord[];
  pending: boolean;
}) {
  return (
    <div className="card sub" data-testid={`ingredient-history-${ingredientId}`} style={{ marginTop: 10 }}>
      <div className="spread">
        <b>改动台账</b>
        <span className="sub">{edits.length} 次</span>
      </div>
      {pending ? (
        <div style={{ marginTop: 6 }}>读取中…</div>
      ) : edits.length === 0 ? (
        <div style={{ marginTop: 6 }}>还没有改过——这是它最初的样子。</div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {edits.map((edit, index) => (
            <div key={index} data-testid={`ingredient-history-item-${ingredientId}-${index}`}>
              {formatTime(edit.changedAt)} · {edit.memberName ?? '不记名'} · 改了
              {edit.changedFields.map((field) => FIELD_LABELS[field] ?? field).join('、')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 「含」字段只存 id + 规范名（不需要完整的 Ingredient 形状）：预填现指针 + 搜索挑新的 */
interface ContainsTarget {
  id: string;
  name: string;
}

/**
 * 「含」提议（issue #37；CONTEXT「『含』提议」；ADR-0012「决定六」）：给一条复合调料预填
 * 几个「可能含」的**字典内**目标。
 *
 * 三处界面口径都在这里落成代码（改前先读）：
 *   * **只从字典现有条目里挑**：建议的标记用字典里的规范名 + id，掌勺者点一下只是把预填放进
 *     chips（**不落库**）——落库与否由后续的录入/保存提交决定。字典里没有可挂的基础条目时
 *     如实报「没有可挂的」并提示可先建那一条（先建「贝类」可能排在「蚝油」前面）。
 *   * **两种空必须说成两句不同的话**：`degraded: false` + 空 = AI 看过了没建议（说「没有可挂的」）；
 *     `degraded: true` = AI 这次用不了（说「AI 暂时用不了，你先自己挂」）。把一次故障说成
 *     「这东西确实不含什么」是错的。
 *   * **降级时不显示任何建议、也不显示「没有建议」**：只提示 AI 不可用且手填照常。
 *
 * 文案用「『含』提议」，**不用**「自动识别忌口」（它只是提议，不是识别）。
 */
function ContainsSuggestionBox({
  request,
  selected,
  onAdopt,
  testId,
}: {
  request: IngredientContainsSuggestionRequest;
  selected: ContainsTarget[];
  onAdopt: (target: IngredientRef) => void;
  testId: string;
}) {
  const suggestion = useContainsSuggestion();
  const result = suggestion.data;
  const degraded = result?.degraded === true;
  // 服务端确实给了建议（与「过滤掉已采纳的之后为空」是两件事——后者不能显示成「没有可挂的」）
  const hasSuggestions = (result?.targets ?? []).length > 0;
  // 已经在 chips 里的不再重复建议（刚采纳过的那条）
  const targets = (result?.targets ?? []).filter((target) => !selected.some((item) => item.id === target.ingredientId));
  // 新建时名字还没填就别提议（空名字没有可建议的对象）
  const ready = request.id !== undefined || (request.name ?? '').trim() !== '';

  return (
    <div className={styles.suggestionBox} data-testid={`ingredient-contains-suggest-box-${testId}`}>
      <button
        type="button"
        className={styles.rowAction}
        data-testid={`ingredient-contains-suggest-${testId}`}
        disabled={suggestion.isPending || !ready}
        onClick={() => suggestion.mutate(request)}
      >
        {suggestion.isPending ? '问一下 AI…' : '「含」提议'}
      </button>

      {suggestion.isError ? (
        <div className={styles.error} data-testid={`ingredient-contains-suggest-error-${testId}`}>
          提议没问成，刷新一下页面再试。
        </div>
      ) : null}

      {degraded ? (
        // 降级：只说 AI 用不了，**不显示任何建议、也不显示「没有建议」**——手填照常
        <div className={styles.note} data-testid={`ingredient-contains-suggest-degraded-${testId}`}>
          AI 暂时用不了，你先自己挂。
        </div>
      ) : result && !hasSuggestions ? (
        // AI 看过了、没有建议：如实报「没有可挂的」，并提示可先建那一条
        <div className={styles.note} data-testid={`ingredient-contains-suggest-empty-${testId}`}>
          没有可挂的目标——字典里没有可挂的基础条目，先建那一条（如「贝类」）再回来。
        </div>
      ) : result && targets.length > 0 ? (
        <div className={`${styles.note} ${styles.noteInfo}`} data-testid={`ingredient-contains-suggestions-${testId}`}>
          <span className="sub">可能含（点一下填进去，确认才保存）：</span>
          <div className={styles.suggestions}>
            {targets.map((target) => (
              <button
                key={target.ingredientId}
                type="button"
                className={styles.suggestion}
                data-testid={`ingredient-contains-suggestion-${testId}-${target.ingredientId}`}
                onClick={() => onAdopt(target)}
              >
                ＋ {target.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 录入表单（只有一个必填项：规范名）。撞名时给冲突对象与「用这条」。 */
function CreateIngredientCard({
  initialName,
  onCreated,
  onCancel,
}: {
  initialName: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [aliasesText, setAliasesText] = useState('');
  const [months, setMonths] = useState<number[]>([]);
  const [contains, setContains] = useState<ContainsTarget[]>([]);
  const [containsQuery, setContainsQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<IngredientConflict | null>(null);
  const create = useCreateIngredient();

  const candidates = (useIngredients(containsQuery).data ?? [])
    .filter((option) => !contains.some((selected) => selected.id === option.id))
    .slice(0, 6)
    .map((option) => ({ id: option.id, name: option.name }));

  const submit = async (): Promise<void> => {
    setError(null);
    setConflict(null);
    try {
      const created = await create.mutateAsync({
        name,
        aliases: parseAliases(aliasesText),
        seasonMonths: months,
        contains: contains.map((item) => item.id),
      });
      onCreated(created.id);
    } catch (err) {
      if (err instanceof IngredientWriteError && err.code === 'ingredient_conflict' && err.conflict) {
        setConflict(err.conflict);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('录入没成功');
      }
    }
  };

  return (
    <div className="card" data-testid="ingredient-editor-new">
      <div className="spread">
        <b>录入一条新食材</b>
        <span className="sub">只有规范名是必填的</span>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>规范名（必填）</span>
        <input
          className={styles.input}
          type="text"
          value={name}
          placeholder="如 莴笋"
          aria-label="食材规范名"
          data-testid="ingredient-name-new"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>别名（可不填，用逗号或顿号分开）</span>
        <input
          className={styles.input}
          type="text"
          value={aliasesText}
          placeholder="如 青笋、莴苣笋"
          aria-label="食材别名"
          data-testid="ingredient-aliases-new"
          onChange={(event) => setAliasesText(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>时令月份（可不填 = 四季有售）</span>
        <div className={styles.months}>
          {MONTHS.map((month) => {
            const on = months.includes(month);
            return (
              <button
                key={month}
                type="button"
                className={on ? `${styles.month} ${styles.monthOn}` : styles.month}
                aria-pressed={on}
                data-testid={`ingredient-month-new-${month}`}
                onClick={() =>
                  setMonths((current) =>
                    current.includes(month) ? current.filter((item) => item !== month) : [...current, month].sort((a, b) => a - b),
                  )
                }
              >
                {month}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.field}>
        <span className={styles.label}>隐性忌口「含」（可不填，只能挑字典里现有的）</span>
        <input
          className={styles.input}
          type="text"
          value={containsQuery}
          placeholder="搜食材（如 贝类）"
          aria-label="搜「含」的目标"
          data-testid="ingredient-contains-search-new"
          onChange={(event) => setContainsQuery(event.target.value)}
        />
        {containsQuery.trim() !== '' && candidates.length > 0 ? (
          <div className={styles.suggestions}>
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={styles.suggestion}
                data-testid={`ingredient-contains-option-${candidate.id}`}
                onClick={() => {
                  setContains((current) => [...current, candidate]);
                  setContainsQuery('');
                }}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        ) : null}
        {contains.length > 0 ? (
          <div className={styles.chips}>
            {contains.map((target) => (
              <button
                key={target.id}
                type="button"
                className={styles.chip}
                aria-label={`去掉 ${target.name}`}
                data-testid={`ingredient-contains-chip-${target.id}`}
                onClick={() => setContains((current) => current.filter((item) => item.id !== target.id))}
              >
                {target.name} ✕
              </button>
            ))}
          </div>
        ) : null}
        <ContainsSuggestionBox
          request={{ name }}
          selected={contains}
          onAdopt={(target) => setContains((current) => (current.some((item) => item.id === target.ingredientId) ? current : [...current, { id: target.ingredientId, name: target.name }]))}
          testId="new"
        />
      </div>

      {conflict ? (
        <div className={styles.conflict} data-testid="ingredient-conflict">
          「{conflict.name}」已经在字典里了——别建重复的，直接用那一条。
          <div className={styles.actions}>
            <button
              type="button"
              className="btn"
              data-testid="ingredient-use-conflict"
              onClick={() => onCreated(conflict.id)}
            >
              用这条
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className={styles.error} data-testid="ingredient-error-new">
          {error}
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className="btn"
          data-testid="ingredient-save-new"
          disabled={create.isPending}
          onClick={() => void submit()}
        >
          录入食材
        </button>
        <button
          type="button"
          className="btn ghost"
          data-testid="ingredient-create-cancel"
          disabled={create.isPending}
          onClick={onCancel}
        >
          返回列表
        </button>
      </div>
    </div>
  );
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** 台账的 `changedFields` 是字段名，这里是给人看的说法（与台账同源，不手写两份） */
const FIELD_LABELS: Record<string, string> = {
  name: '规范名',
  aliases: '别名',
  seasonMonths: '时令月份',
  contains: '「含」指针',
};

/** 搜规范名或别名（与列表接口同一口径；家人说「西红柿」，字典里叫「番茄」） */
function matchKeyword(ingredient: Ingredient, keyword: string): boolean {
  if (keyword === '') return true;
  return ingredient.name.includes(keyword) || ingredient.aliases.some((alias) => alias.includes(keyword));
}

/** 时令月份的人话：空数组 = 四季有售（不写月份行） */
function seasonLabel(months: number[]): string {
  return months.length > 0 ? `${months.join('、')} 月` : '四季有售';
}

/** 引用类别的中文名（说清「被谁用着」，而不是只报一个英文表名）。
 * 用 `Record<IngredientReferenceKind, string>` 而不是 `Record<string, string>`：
 * `wire-types` 新增一类引用时，这里会因缺键而编译不过，不会默默退回英文表名。 */
const REFERENCE_LABELS: Record<IngredientReferenceKind, string> = {
  recipe_ingredients: '道菜谱的食材清单',
  member_avoid: '处家人忌口',
  member_loves: '处家人爱吃',
  exchange_items: '条生熟互换',
  grocery_items: '行买菜清单',
  ingredient_contains: '条食材的「含」指针',
};

/** 把引用清单拼成一句「被谁用着、几条」 */
function referenceSummary(references: IngredientReferenceCount[]): string {
  return references.map((reference) => `${reference.count} ${REFERENCE_LABELS[reference.kind]}`).join('、');
}

/** 台账时刻 → 「6 月 1 日 18:30」这类展示（与 `RecipeEditor` 同一口径；服务端存的是 ISO） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hour}:${minute}`;
}
