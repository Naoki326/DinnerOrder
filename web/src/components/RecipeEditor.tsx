import { useEffect, useState } from 'react';
import type { Recipe, RecipeCuisine, RecipeEffort, RecipeIngredientInput, RecipeKind, TasteTag } from '@dinnerorder/server/types';
import { usePatchRecipe, useRecipeEdits, useRecipeStatusAction } from '../api/recipe-library';
import { useIngredients } from '../api/ingredients';
import {
  CUISINE_OPTIONS,
  EFFORT_OPTIONS,
  KIND_OPTIONS,
  TASTE_OPTIONS,
} from './recipeVocabulary';
import styles from './RecipeEditor.module.css';

/**
 * 一道菜的详情与编辑（issue #30；ADR-0009、CONTEXT「修订」）。
 *
 * 干三件事：
 *   1. **先看见它现在的完整内容**（做法 + 逐项克数）——改的时候有参照；
 *   2. **改**：字段与 `PATCH /recipes/:id` 的入参一一对应；
 *   3. **退役 / 还原**，以及**修改历史**（谁、什么时候、改了什么）。
 *
 * 四条口径（改之前先读）：
 *   * **克数不许存 0**：已存在的 0 克项（导入期的「待重标」）显示为**空 + 标红 + 不给保存**——
 *     等于把「待重标」从 LLM 的活变成掌勺者能手工补的活。这也是本票让「待处理」真的减少的路径。
 *   * **不复用转正的 LLM 改写链路**：ADR-0001/0006 把 LLM 改写特定在**转正**这个有确认门槛的动作上；
 *     搬到日常编辑页等于让 LLM 产出绕过门槛直接进 steps。务实理由同样成立：编辑页里出现
 *     「保存失败：AI 改写失败」是纯噪音。
 *   * **身份不改**：菜名/来源/别名原样保留（改的是内容，不是这道菜从哪来）。菜名可改，但那是
 *     掌勺者明确的动作，不是保存时顺手改名。
 *   * **台账是只读的**：`recipe_edits` 由服务端在每次修订时写入，界面只呈现。
 */
export function RecipeEditor({ recipe, memberId }: { recipe: Recipe; memberId: string | undefined }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(recipe));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const patch = usePatchRecipe();
  const action = useRecipeStatusAction();
  const edits = useRecipeEdits(recipe.id);

  // 菜谱被别处改过（保存成功后缓存刷新）：把草稿同步到服务端的那一份——
  // 但仍然保留下面的本地编辑，只在**没有未保存改动**时才重置（否则会把用户正在敲的字冲掉）
  useEffect(() => {
    setDraft((current) => (current.dirty ? current : toDraft(recipe)));
  }, [recipe]);

  const gramsInvalid = draft.ingredients.some((item) => item.adultGramsText.trim() === '' || Number(item.adultGramsText) <= 0);
  const nameInvalid = draft.name.trim() === '';
  const canSave = !gramsInvalid && !nameInvalid && draft.dirty && !patch.isPending;

  function update(patchToApply: Partial<Draft>): void {
    setSaved(false);
    setDraft((current) => ({ ...current, ...patchToApply, dirty: true }));
  }

  return (
    <div data-testid={`recipe-editor-${recipe.id}`}>
      <div className="card">
        <div className="spread">
          <b>{recipe.name}</b>
          <span className="badge">{statusLabel(recipe.status)}</span>
        </div>
        <div className="sub" style={{ marginTop: 4 }}>
          {sourceLabel(recipe.source)}
          {recipe.neverServed ? ' · 还没上过桌' : ''}
        </div>
      </div>

      {/* 状态动作（退役 / 还原）：与编辑表单分开，因为它们是状态机的事，不是内容的事 */}
      <div className="card" data-testid={`recipe-status-${recipe.id}`}>
        <div className="spread">
          <span className="sub">
            {recipe.status === 'retired'
              ? '这道菜退役了：不进推荐，历史记录（吃过的餐、它的评价）完整保留。'
              : '退役 = 家里不再做了：退出推荐池，历史记录保留。'}
          </span>
          {recipe.status === 'retired' ? (
            <button
              type="button"
              className="btn ghost"
              data-testid={`recipe-restore-${recipe.id}`}
              disabled={action.isPending || !memberId}
              onClick={() =>
                action.mutate(
                  { recipeId: recipe.id, action: 'restore', input: memberId ? { memberId } : {} },
                  { onError: (cause) => setError(cause.message) },
                )
              }
            >
              还原
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost"
              data-testid={`recipe-retire-${recipe.id}`}
              disabled={action.isPending || !memberId}
              onClick={() =>
                action.mutate(
                  { recipeId: recipe.id, action: 'retire', input: memberId ? { memberId } : {} },
                  { onError: (cause) => setError(cause.message) },
                )
              }
            >
              退役
            </button>
          )}
        </div>
        {action.isError ? (
          <div className={styles.error} data-testid={`recipe-status-error-${recipe.id}`}>
            {action.error.message}
          </div>
        ) : null}
      </div>

      <div className="card" data-testid={`recipe-form-${recipe.id}`}>
        <div className={styles.field}>
          <span className={styles.label}>菜名</span>
          <input
            className={styles.input}
            type="text"
            value={draft.name}
            aria-label="菜名"
            data-testid={`recipe-name-${recipe.id}`}
            onChange={(event) => update({ name: event.target.value })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>荤素</span>
          <select
            className={styles.select}
            aria-label="荤素汤位"
            data-testid={`recipe-kind-${recipe.id}`}
            value={draft.kind}
            onChange={(event) => update({ kind: event.target.value as RecipeKind })}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>难度</span>
          <select
            className={styles.select}
            aria-label="难度"
            data-testid={`recipe-effort-${recipe.id}`}
            value={draft.effort}
            onChange={(event) => update({ effort: event.target.value as RecipeEffort })}
          >
            {EFFORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>菜系</span>
          <select
            className={styles.select}
            aria-label="菜系"
            data-testid={`recipe-cuisine-${recipe.id}`}
            value={draft.cuisine}
            onChange={(event) => update({ cuisine: event.target.value })}
          >
            <option value="">不标</option>
            {CUISINE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldTop}>
          <span className={styles.label}>口味</span>
          <div className={styles.chips}>
            {TASTE_OPTIONS.map((taste) => {
              const on = draft.tastes.includes(taste);
              return (
                <button
                  key={taste}
                  type="button"
                  className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                  data-testid={`recipe-taste-${recipe.id}-${taste}`}
                  aria-pressed={on}
                  onClick={() =>
                    update({ tastes: on ? draft.tastes.filter((item) => item !== taste) : [...draft.tastes, taste] })
                  }
                >
                  {taste}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.fieldTop}>
          <span className={styles.label}>适季</span>
          <div className={styles.chips}>
            {MONTHS.map((month) => {
              const on = draft.seasonMonths.includes(month);
              return (
                <button
                  key={month}
                  type="button"
                  className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip}
                  data-testid={`recipe-month-${recipe.id}-${month}`}
                  aria-pressed={on}
                  onClick={() =>
                    update({
                      seasonMonths: on
                        ? draft.seasonMonths.filter((item) => item !== month)
                        : [...draft.seasonMonths, month],
                    })
                  }
                >
                  {month}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.fieldTop}>
          <span className={styles.label}>做法</span>
          <textarea
            className={styles.textarea}
            value={draft.steps}
            rows={4}
            placeholder="一步一步写，或者就写个大概"
            aria-label="做法步骤"
            data-testid={`recipe-steps-${recipe.id}`}
            onChange={(event) => update({ steps: event.target.value })}
          />
        </div>
      </div>

      {/* 食材与克数：0 克项显示为空 + 标红 + 不给保存（「待重标」变成掌勺者能手工补的活） */}
      <div className="card" data-testid={`recipe-ingredients-${recipe.id}`}>
        <div className="spread">
          <b>食材与成人份克数</b>
          <span className="sub">{draft.ingredients.length} 项</span>
        </div>
        <div className="sub" style={{ marginTop: 4 }}>
          一个成人一餐这道菜的生重。克数必须大于 0——拿不准就填个估计值。
        </div>

        {draft.ingredients.map((item, index) => {
          const bad = item.adultGramsText.trim() === '' || Number(item.adultGramsText) <= 0;
          return (
            <div key={`${item.ingredientId}-${index}`} className={styles.ingredientRow}>
              <span className={styles.ingredientName}>{item.name}</span>
              <input
                className={bad ? `${styles.grams} ${styles.gramsBad}` : styles.grams}
                type="text"
                inputMode="decimal"
                value={item.adultGramsText}
                placeholder={bad ? '必填' : ''}
                aria-label={`${item.name}的克数`}
                aria-invalid={bad}
                data-testid={`recipe-grams-${recipe.id}-${index}`}
                onChange={(event) =>
                  update({
                    ingredients: draft.ingredients.map((current, at) =>
                      at === index ? { ...current, adultGramsText: event.target.value } : current,
                    ),
                  })
                }
              />
              <span className={styles.unit}>g</span>
              <button
                type="button"
                className={styles.remove}
                aria-label={`去掉${item.name}`}
                data-testid={`recipe-remove-ingredient-${recipe.id}-${index}`}
                onClick={() => update({ ingredients: draft.ingredients.filter((_current, at) => at !== index) })}
              >
                去掉
              </button>
            </div>
          );
        })}

        {gramsInvalid ? (
          <div className={styles.error} data-testid={`recipe-grams-error-${recipe.id}`}>
            有项克数还没定——填上才能保存（红色那几项）。
          </div>
        ) : null}

        <AddIngredient
          onAdd={(ingredient) =>
            update({
              ingredients: [
                ...draft.ingredients,
                { ingredientId: ingredient.id, name: ingredient.name, adultGramsText: '' },
              ],
            })
          }
        />
      </div>

      <div className="card">
        <div className="row">
          <button
            type="button"
            className="btn"
            data-testid={`recipe-save-${recipe.id}`}
            disabled={!canSave}
            onClick={() => {
              setError(undefined);
              setSaved(false);
              patch.mutate(
                {
                  recipeId: recipe.id,
                  input: {
                    name: draft.name.trim(),
                    kind: draft.kind,
                    effort: draft.effort,
                    cuisine: draft.cuisine === '' ? null : (draft.cuisine as RecipeCuisine),
                    tastes: draft.tastes,
                    seasonMonths: draft.seasonMonths,
                    steps: draft.steps,
                    ingredients: draft.ingredients.map(toIngredientInput),
                    ...(memberId === undefined ? {} : { memberId }),
                  },
                },
                {
                  onSuccess: () => {
                    setSaved(true);
                    setDraft((current) => ({ ...current, dirty: false }));
                  },
                  onError: (cause) => setError(cause.message),
                },
              );
            }}
          >
            {patch.isPending ? '保存中…' : '保存'}
          </button>
        </div>
        {saved && !draft.dirty ? (
          <div className={styles.ok} data-testid={`recipe-saved-${recipe.id}`}>
            已保存
          </div>
        ) : null}
        {error ? (
          <div className={styles.error} data-testid={`recipe-error-${recipe.id}`}>
            {error}
          </div>
        ) : null}
        {/* 名字或克数不合法时把按钮为什么灰着说出来 */}
        {!canSave && !patch.isPending && (gramsInvalid || nameInvalid) ? (
          <div className="sub" data-testid={`recipe-save-blocked-${recipe.id}`}>
            {nameInvalid ? '菜名不能为空。' : '有项克数还没定，填上才能保存。'}
          </div>
        ) : null}
      </div>

      <EditHistory recipeId={recipe.id} edits={edits.data ?? []} pending={edits.isPending} />
    </div>
  );
}

/** 修改历史（台账）：谁、什么时候、改了什么。只读，由服务端在每次修订时写入。 */
function EditHistory({
  recipeId,
  edits,
  pending,
}: {
  recipeId: string;
  edits: { editedAt: string; memberName: string | null; changedFields: string[] }[];
  pending: boolean;
}) {
  return (
    <div className="card" data-testid={`recipe-history-${recipeId}`}>
      <div className="spread">
        <b>修改历史</b>
        <span className="sub">{edits.length} 次</span>
      </div>
      {pending ? (
        <div className="sub" style={{ marginTop: 6 }}>
          读取中…
        </div>
      ) : edits.length === 0 ? (
        <div className="sub" style={{ marginTop: 6 }}>
          还没有改过——这是它最初的样子。
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {edits.map((edit, index) => (
            <div key={index} className="sub" data-testid={`recipe-history-item-${recipeId}-${index}`}>
              {formatTime(edit.editedAt)} · {edit.memberName ?? '不记名'} · 改了
              {edit.changedFields.map((field) => FIELD_LABELS[field] ?? field).join('、')}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 加一项食材：按名字/别名搜字典，选中即加（克数留空等掌勺者填） */
function AddIngredient({ onAdd }: { onAdd: (ingredient: { id: string; name: string }) => void }) {
  const [query, setQuery] = useState('');
  const results = useIngredients(query);
  const hit = results.data ?? [];

  return (
    <div className={styles.add} data-testid="recipe-add-ingredient">
      <div className={styles.field}>
        <span className={styles.label}>加食材</span>
        <input
          className={styles.input}
          type="text"
          value={query}
          placeholder="搜食材（如 番茄 / 西红柿）"
          aria-label="搜食材"
          data-testid="recipe-ingredient-search"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {query.trim() !== '' && hit.length === 0 && !results.isPending ? (
        <div className="sub">字典里没有对得上的食材。</div>
      ) : null}
      {hit.slice(0, 8).map((ingredient) => (
        <button
          key={ingredient.id}
          type="button"
          className={styles.addOption}
          data-testid={`recipe-add-${ingredient.id}`}
          onClick={() => {
            onAdd({ id: ingredient.id, name: ingredient.name });
            setQuery('');
          }}
        >
          {ingredient.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 草稿形状

interface DraftIngredient {
  ingredientId: string;
  name: string;
  /** 用字符串存输入框的值：空串是「还没填」，不能折成 0（0 会看起来像「不需要买」） */
  adultGramsText: string;
}

interface Draft {
  name: string;
  kind: RecipeKind;
  effort: RecipeEffort;
  cuisine: string;
  tastes: TasteTag[];
  seasonMonths: number[];
  steps: string;
  ingredients: DraftIngredient[];
  /** 有没有本地未保存的改动（决定保存按钮的可用性与「同步服务端那份」的时机） */
  dirty: boolean;
}

function toDraft(recipe: Recipe): Draft {
  return {
    name: recipe.name,
    kind: recipe.kind,
    effort: recipe.effort,
    cuisine: recipe.cuisine ?? '',
    tastes: [...recipe.tastes],
    seasonMonths: [...recipe.seasonMonths].sort((a, b) => a - b),
    steps: recipe.steps,
    ingredients: recipe.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      name: item.name,
      // 0 克（导入期的「待重标」）显示为空，逼掌勺者填一个真数——这是本票让「待处理」真的减少的路径
      adultGramsText: item.adultGrams > 0 ? String(item.adultGrams) : '',
    })),
    dirty: false,
  };
}

function toIngredientInput(item: DraftIngredient): RecipeIngredientInput {
  return { ingredientId: item.ingredientId, adultGrams: Number(item.adultGramsText) };
}

// ---------------------------------------------------------------- 展示词汇

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** 字段名 → 界面上的说法（台账的 `changedFields` 是字段名，这里是给人看的） */
const FIELD_LABELS: Record<string, string> = {
  name: '菜名',
  kind: '荤素位',
  effort: '难度',
  cuisine: '菜系',
  tastes: '口味',
  seasonMonths: '适季月份',
  steps: '做法',
  ingredients: '食材清单',
  status: '状态',
};

function statusLabel(status: Recipe['status']): string {
  return status === 'active' ? '家庭菜谱' : status === 'draft' ? '外部菜谱' : '已退役';
}

function sourceLabel(source: Recipe['source']): string {
  return source === 'howtocook'
    ? '来自 HowToCook'
    : source === 'scraped'
      ? '来自下厨房'
      : source === 'llm'
        ? 'LLM 生成'
        : '口述与手写';
}

/** 台账时刻 → 「昨天 18:30」这类相对时间（前端展示用；服务端存的是 ISO） */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month} 月 ${day} 日 ${hour}:${minute}`;
}
