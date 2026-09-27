import { useEffect, useState } from 'react';
import type { Recipe, RecipeCuisine, RecipeEffort, RecipeIngredientInput, RecipeKind, TasteTag } from '@dinnerorder/server/types';
import {
  useCreateRecipe,
  useImportRecipe,
  usePatchRecipe,
  useRecipeEdits,
  useRecipeStatusAction,
  type RecipeImportPreview,
} from '../api/recipe-library';
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
 * 三种形态共用一个组件（否则要把同一张表单抄三遍）：
 *   * **录入**（`creating`）：空表单，提交走 `POST /recipes`（ADR-0009：直接 active + oral）；
 *   * **修订**（默认）：已有菜谱的可编辑表单，提交走 `PATCH`；
 *   * **只读**（`readOnly`）：草稿 / 已退役的菜——内容看得见，表单不可编、保存按钮不出现。
 *     为什么不是“禁用表单 + 灰着的保存”：草稿的下一步是「上桌 → 转正」（在餐后回顾里），
 *     退役的下一步是「还原」——界面上把**下一步**说出来，比给一个按下必报 409 的按钮好。
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
export function RecipeEditor({
  recipe,
  memberId,
  creating = false,
  readOnly = false,
  onCreated,
}: {
  /** 要编辑的菜；录入时传 undefined（表单从空开始） */
  recipe?: Recipe;
  memberId: string | undefined;
  /** 录入一道新菜（ADR-0009）：提交走 POST /recipes 而不是 PATCH */
  creating?: boolean;
  /** 只读（草稿 / 已退役）：内容看得见，但不能编——下一步是转正或还原，不是 PATCH */
  readOnly?: boolean;
  /** 录入成功后的回调（页面用它回到列表并打开刚录的那道） */
  onCreated?: (recipe: Recipe) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(recipe));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  /** 导入预览里那些**没对上字典**的食材项（只做展示：掌勺者照这个去下面的搜框手动加） */
  const [unmatched, setUnmatched] = useState<RecipeImportPreview['unmatched']>([]);
  /** 这次导入是怎么来的（取正文有无降级、几项没克数）——不静默 */
  const [importNotes, setImportNotes] = useState<string[]>([]);

  const create = useCreateRecipe();
  const patch = usePatchRecipe();
  const action = useRecipeStatusAction();
  const edits = useRecipeEdits(recipe?.id ?? null);
  const pendingWrite = create.isPending || patch.isPending;
  /** 表单 testid 的稳定键：录入时是 `new`（那时候还没有菜谱 id） */
  const fieldKey = recipe?.id ?? 'new';

  // 菜谱被别处改过（保存成功后缓存刷新）：把草稿同步到服务端的那一份——
  // 但仍然保留下面的本地编辑，只在**没有未保存改动**时才重置（否则会把用户正在敲的字冲掉）
  useEffect(() => {
    if (!recipe || creating) return;
    setDraft((current) => (current.dirty ? current : toDraft(recipe)));
  }, [recipe, creating]);

  const gramsInvalid = draft.ingredients.some((item) => item.adultGramsText.trim() === '' || Number(item.adultGramsText) <= 0);
  const nameInvalid = draft.name.trim() === '';
  // 录入时空表单也算「有改动」（它本来就是一张要填的空表）；修订时要求真的变了什么
  const hasChanges = creating ? true : draft.dirty;
  const canSave = !readOnly && !gramsInvalid && !nameInvalid && hasChanges && !pendingWrite;

  function update(patchToApply: Partial<Draft>): void {
    setSaved(false);
    setDraft((current) => ({ ...current, ...patchToApply, dirty: true }));
  }

  return (
    <div data-testid={`recipe-editor-${fieldKey}`}>
      <div className="card">
        <div className="spread">
          <b>{creating ? '录入一道新菜' : recipe?.name}</b>
          {recipe ? <span className="badge">{statusLabel(recipe.status)}</span> : null}
        </div>
        {creating ? (
          <div className="sub" style={{ marginTop: 4 }}>
            录完直接可用：你自己的手艺就是信任背书，不需要先做一顿。
          </div>
        ) : (
          <div className="sub" style={{ marginTop: 4 }}>
            {sourceLabel(recipe!.source)}
            {recipe!.neverServed ? ' · 还没上过桌' : ''}
          </div>
        )}
        {/* 原始来源（迁移 015）：导入来的菜能回溯到那条链接。只读——它记录的是「这道菜从哪来」，
            不是可编辑的内容（改来源等于让「出身」可随编辑漂移）。 */}
        {!creating && recipe?.sourceRef ? (
          <div className={`sub ${styles.sourceRef}`} data-testid={`recipe-source-ref-${recipe.id}`}>
            {recipe.sourceRef.startsWith('http') ? '来源：' : ''}
            {recipe.sourceRef.startsWith('http') ? (
              <a href={recipe.sourceRef} target="_blank" rel="noreferrer noopener">
                {recipe.sourceRef}
              </a>
            ) : (
              recipe.sourceRef
            )}
          </div>
        ) : null}
      </div>

      {/* 只读的原因与下一步（草稿要转正、退役要还原）：不给一个按下必报错的表单 */}
      {readOnly && recipe ? (
        <div className="card" data-testid={`recipe-readonly-${fieldKey}`}>
          <div className="sub">
            这道菜退役了——先点下面的「还原」，回到家庭菜谱之后才能改。
          </div>
        </div>
      ) : null}

      {/* 状态动作（退役 / 还原）：与编辑表单分开，因为它们是状态机的事，不是内容的事。
          录入时没有状态动作；只读时给「还原」（退役菜的唯一出口）；非只读时给退役。 */}
      {!creating && recipe ? (
        <div className="card" data-testid={`recipe-status-${fieldKey}`}>
          <div className="spread">
            <span className="sub">
              {recipe.status === 'retired'
                ? '这道菜退役了：不进推荐，历史记录（吃过的餐、它的评价）完整保留。'
                : '退役 = 家里不再做了：退出推荐池，历史记录保留。'}
            </span>
            {readOnly && recipe.status !== 'retired' ? null : recipe.status === 'retired' ? (
              <button
                type="button"
                className="btn ghost"
                data-testid={`recipe-restore-${fieldKey}`}
                disabled={action.isPending || !memberId}
                onClick={() =>
                  action.mutate(
                    { recipeId: recipe!.id, action: 'restore', input: memberId ? { memberId } : {} },
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
                data-testid={`recipe-retire-${fieldKey}`}
                disabled={action.isPending || !memberId}
                onClick={() =>
                  action.mutate(
                    { recipeId: recipe!.id, action: 'retire', input: memberId ? { memberId } : {} },
                    { onError: (cause) => setError(cause.message) },
                  )
                }
              >
                退役
              </button>
            )}
          </div>
          {action.isError ? (
            <div className={styles.error} data-testid={`recipe-status-error-${fieldKey}`}>
              {action.error.message}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card" data-testid={`recipe-form-${fieldKey}`}>
        {/* 导入（issue #32）：只在**录入**这一档给。改已有的菜不走这条——ADR-0001/0006 把 LLM
            改写特定在转正那一步，且改菜时「重新导入一遍」会把掌勺者刚校对的改动冲掉 */}
        {creating ? (
          <ImportPanel
            memberId={memberId}
            onPreview={(preview, notes) => {
              setError(undefined);
              setSaved(false);
              // 整套替换草稿：导入的语义是「从这段素材重新来一份」，不是「往现有草稿上合并」——
              // 合并会让「哪些是 AI 给的、哪些是我自己写的」永远说不清。
              setDraft({ ...toDraftFromPreview(preview), dirty: true });
              setUnmatched(preview.unmatched);
              setImportNotes(notes);
            }}
          />
        ) : null}

        {/* 归一失败的项：**不静默丢**（AC 明文）——摆出来让掌勺者用下面的搜框加进去 */}
        {creating && unmatched.length > 0 ? (
          <div className={styles.unmatched} data-testid="recipe-unmatched-new">
            <b>这几项没对上食材字典</b>
            <div className="sub">
              它们不会进菜谱。可以在下面「加食材」里搜个近似的（如「番茄沙司」），或者跳过。
            </div>
            {unmatched.map((item) => (
              <div key={item.name} className={styles.unmatchedRow} data-testid={`recipe-unmatched-item-${item.name}`}>
                <span>{item.name}</span>
                <span className="sub">{item.grams === null ? '素材没给克数' : `素材里约 ${item.grams} g`}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* 导入过程本身的信息（走的是哪一档、几项没克数）：成功但需要注意的事不静默 */}
        {creating && importNotes.length > 0 ? (
          <div className="sub" data-testid="recipe-import-notes-new">
            {importNotes.join('；')}
          </div>
        ) : null}
        <div className={styles.field}>
          <span className={styles.label}>菜名</span>
          <input
            className={styles.input}
            type="text"
            value={draft.name}
            aria-label="菜名"
            data-testid={`recipe-name-${fieldKey}`}
                disabled={readOnly}
            onChange={(event) => update({ name: event.target.value })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>荤素</span>
          <select
            className={styles.select}
            aria-label="荤素汤位"
            data-testid={`recipe-kind-${fieldKey}`}
                disabled={readOnly}
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
            data-testid={`recipe-effort-${fieldKey}`}
                disabled={readOnly}
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
            data-testid={`recipe-cuisine-${fieldKey}`}
                disabled={readOnly}
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
                  data-testid={`recipe-taste-${fieldKey}-${taste}`}
                  disabled={readOnly}
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
                  data-testid={`recipe-month-${fieldKey}-${month}`}
                  disabled={readOnly}
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
            data-testid={`recipe-steps-${fieldKey}`}
                disabled={readOnly}
            onChange={(event) => update({ steps: event.target.value })}
          />
        </div>
      </div>

      {/* 食材与克数：0 克项显示为空 + 标红 + 不给保存（「待重标」变成掌勺者能手工补的活） */}
      <div className="card" data-testid={`recipe-ingredients-${fieldKey}`}>
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
                disabled={readOnly}
                data-testid={`recipe-grams-${fieldKey}-${index}`}
                onChange={(event) =>
                  update({
                    ingredients: draft.ingredients.map((current, at) =>
                      at === index ? { ...current, adultGramsText: event.target.value } : current,
                    ),
                  })
                }
              />
              <span className={styles.unit}>g</span>
              {/* 只读态不给「去掉」：草稿/退役菜的清单变更各自走转正与还原，不是编辑页的事 */}
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`去掉${item.name}`}
                  data-testid={`recipe-remove-ingredient-${fieldKey}-${index}`}
                  onClick={() => update({ ingredients: draft.ingredients.filter((_current, at) => at !== index) })}
                >
                  去掉
                </button>
              )}
            </div>
          );
        })}

        {!readOnly && gramsInvalid ? (
          <div className={styles.error} data-testid={`recipe-grams-error-${fieldKey}`}>
            有项克数还没定——填上才能保存（红色那几项）。
          </div>
        ) : null}

        {readOnly ? null : (
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
        )}
      </div>

      {/* 只读态不出现保存按钮：下一步是转正或还原，不是 PATCH */}
      {readOnly ? null : (
        <div className="card">
          <div className="row">
            <button
              type="button"
              className="btn"
              data-testid={`recipe-save-${fieldKey}`}
              disabled={!canSave}
              onClick={() => {
                setError(undefined);
                setSaved(false);
                const input = {
                  name: draft.name.trim(),
                  kind: draft.kind,
                  effort: draft.effort,
                  cuisine: draft.cuisine === '' ? null : (draft.cuisine as RecipeCuisine),
                  tastes: draft.tastes,
                  seasonMonths: draft.seasonMonths,
                  steps: draft.steps,
                  ingredients: draft.ingredients.map(toIngredientInput),
                  // 原始来源（迁移 015）：导入来的菜把链接带回服务端；空串不传（手写录入就是这种）
                  ...(draft.sourceRef.trim() === '' ? {} : { sourceRef: draft.sourceRef.trim() }),
                  ...(memberId === undefined ? {} : { memberId }),
                };
                const done = (created: Recipe): void => {
                  setSaved(true);
                  setDraft((current) => ({ ...current, dirty: false }));
                  onCreated?.(created);
                };
                if (creating) {
                  create.mutate(input, { onSuccess: done, onError: (cause) => setError(cause.message) });
                } else {
                  patch.mutate(
                    { recipeId: recipe!.id, input },
                    { onSuccess: done, onError: (cause) => setError(cause.message) },
                  );
                }
              }}
            >
              {pendingWrite ? '保存中…' : creating ? '录进菜谱库' : '保存'}
            </button>
          </div>
          {saved && !draft.dirty ? (
            <div className={styles.ok} data-testid={`recipe-saved-${fieldKey}`}>
              已保存
            </div>
          ) : null}
          {error ? (
            <div className={styles.error} data-testid={`recipe-error-${fieldKey}`}>
              {error}
            </div>
          ) : null}
          {/* 名字或克数不合法时把按钮为什么灰着说出来 */}
          {!canSave && !pendingWrite && (gramsInvalid || nameInvalid) ? (
            <div className="sub" data-testid={`recipe-save-blocked-${fieldKey}`}>
              {nameInvalid ? '菜名不能为空。' : '有项克数还没定，填上才能保存。'}
            </div>
          ) : null}
        </div>
      )}

      {/* 修改历史：录入时与只读态都不显示（前者还没有历史，后者在台账卡片里也不该有写入入口） */}
      {creating || readOnly ? null : (
        <EditHistory recipeId={recipe!.id} edits={edits.data ?? []} pending={edits.isPending} />
      )}
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
  /**
   * 原始来源（迁移 015）：导入时记下的链接/来源说明，手写录入是空串。
   * 它随保存一起交给服务端，并在详情里显示一句「来源：…」让人能回溯。
   */
  sourceRef: string;
  /** 有没有本地未保存的改动（决定保存按钮的可用性与「同步服务端那份」的时机） */
  dirty: boolean;
}

function toDraft(recipe: Recipe | undefined): Draft {
  // 录入（没有菜谱）：给一张能直接用的空表（荤菜、中等难度是缺省，录完能改）
  if (!recipe) {
    return {
      name: '',
      kind: 'meat',
      effort: 'medium',
      cuisine: '',
      tastes: [],
      seasonMonths: [],
      steps: '',
      ingredients: [],
      sourceRef: '',
      dirty: false,
    };
  }
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
    sourceRef: recipe.sourceRef ?? '',
    dirty: false,
  };
}

/**
 * 导入预览 → 草稿（issue #32）。与 `toDraft` 分开的原因：预览不是 `Recipe`
 * （它带 `unmatched`/`notes`/`llm`，而食材是 `ingredientId + name` 而不是完整的 `RecipeIngredient`）。
 *
 * **克数为 0 的项显示为空**（与 `toDraft` 对库里 0 克的处置一致）：预览里 0 = 「模型没给克数」，
 * 编辑器会把它标红、不给保存——这正是我们要的，他必须为这一项填一个数，
 * 而不是让一个「待定」悄悄存进库。
 */
function toDraftFromPreview(preview: RecipeImportPreview): Draft {
  return {
    name: preview.name,
    kind: preview.kind,
    effort: preview.effort,
    cuisine: preview.cuisine ?? '',
    tastes: [...preview.tastes],
    seasonMonths: [...preview.seasonMonths].sort((a, b) => a - b),
    steps: preview.steps,
    ingredients: preview.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      name: item.name,
      adultGramsText: item.adultGrams > 0 ? String(item.adultGrams) : '',
    })),
    sourceRef: preview.sourceRef,
    dirty: false,
  };
}

/**
 * 导入面板（issue #32）：贴链接或贴文字 → AI 结构化 → 预填下面的编辑器。
 *
 * 两种输入共用一个面板、用 tab 切（**互斥的两档**）：
 *   * 贴链接是主路（少打字），但平台改版/要登录时也失效；
 *   * 贴文字是永远可用的兜底——**取正文失败时的提示直接指向它**，所以它必须在同一屏、不藏起来。
 *
 * 面板自身的错误只影响这个面板（不动编辑器）：导入失败时掌勺者手头那份草稿还在。
 */
function ImportPanel({
  memberId,
  onPreview,
}: {
  memberId: string | undefined;
  onPreview: (preview: RecipeImportPreview, notes: string[]) => void;
}) {
  const [kind, setKind] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const importRecipe = useImportRecipe();

  const value = kind === 'url' ? url : text;
  const canImport = value.trim() !== '' && !importRecipe.isPending;

  return (
    <div className={styles.import} data-testid="recipe-import-panel">
      <div className="spread">
        <b>从链接或文字导入</b>
        <span className="sub">AI 整理成一份草稿，你校对后再存</span>
      </div>

      <div className={styles.importTabs}>
        <button
          type="button"
          className={kind === 'url' ? `${styles.importTab} ${styles.importTabOn}` : styles.importTab}
          data-testid="recipe-import-tab-url"
          aria-pressed={kind === 'url'}
          onClick={() => setKind('url')}
        >
          贴链接
        </button>
        <button
          type="button"
          className={kind === 'text' ? `${styles.importTab} ${styles.importTabOn}` : styles.importTab}
          data-testid="recipe-import-tab-text"
          aria-pressed={kind === 'text'}
          onClick={() => setKind('text')}
        >
          贴文字
        </button>
      </div>

      {kind === 'url' ? (
        <input
          className={styles.input}
          type="url"
          inputMode="url"
          value={url}
          placeholder="粘贴菜谱链接（小红书分享链、菜谱站、博客…）"
          aria-label="菜谱链接"
          data-testid="recipe-import-url"
          onChange={(event) => setUrl(event.target.value)}
        />
      ) : (
        <textarea
          className={styles.textarea}
          rows={5}
          value={text}
          placeholder="把做法文字或视频字幕粘在这里"
          aria-label="做法文字"
          data-testid="recipe-import-text"
          onChange={(event) => setText(event.target.value)}
        />
      )}

      <div className="row">
        <button
          type="button"
          className="btn"
          data-testid="recipe-import-submit"
          disabled={!canImport}
          onClick={() => {
            importRecipe.mutate(
              {
                source: kind === 'url' ? { kind: 'url', url: url.trim() } : { kind: 'text', text: text.trim() },
                ...(memberId === undefined ? {} : { memberId }),
              },
              { onSuccess: (preview) => onPreview(preview, preview.notes) },
            );
          }}
        >
          {importRecipe.isPending ? '整理中…' : '整理成菜谱'}
        </button>
        {importRecipe.isPending ? <span className="sub">取内容 + 让 AI 整理，要几秒</span> : null}
      </div>

      {importRecipe.isError ? (
        <div className={styles.error} data-testid="recipe-import-error">
          {importRecipe.error.message}
        </div>
      ) : null}

      <div className="sub" style={{ marginTop: 6 }}>
        不会直接存进库——整理结果会填到下面的表单里，你核对后点「录进菜谱库」才算数。
        <br />
        有的站点要登录或有人机验证，抓不到；视频里的做法要连字幕一起抓（小红书这类支持），
        实在不行就把做法文字复制出来贴进来。
      </div>
    </div>
  );
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
