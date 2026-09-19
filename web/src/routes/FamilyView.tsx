import { useState } from 'react';
import { useIngredients, type Ingredient } from '../api/ingredients';
import { useRecipes, type Recipe } from '../api/recipes';
import { useUpdateMember, type LoveEntry, type LoveTarget, type Member, type ProfilePatch } from '../api/members';
import { useIdentity } from '../identity';
import { memberSubtitle } from '../components/memberLabel';
import styles from './FamilyView.module.css';

/**
 * 家人画像（总纲 §2.9）：大人/小孩、男/女、出生年月、忌口[]、爱吃[]。
 *
 * 两处交互按「建模不对称」来：
 *   * 忌口是**硬过滤**——条目只能指向食材字典（推荐期命中即排除，含隐性忌口展开）；
 *   * 爱吃是**软加分**——条目可以是食材也可以是具体菜（#15 接通了菜粒度的存取）。
 * 改动即时落库（手机上改完即生效），不做「保存」按钮那种容易忘按的中间态。
 */
export function FamilyView() {
  const { members, current, isPending, isError } = useIdentity();

  return (
    <div data-testid="family-view">
      <div className={`card ${styles.hint}`}>
        <div className="spread">
          <b>家人</b>
          <span className="sub">无登录 · 点右上角头像换当前身份</span>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>
          忌口从推荐里排除（硬过滤）；爱吃给推荐加分（软加分）——爱吃可以是食材，也可以是具体某道菜。
        </div>
      </div>

      {isPending ? <div className={`card sub`}>读取中…</div> : null}
      {isError ? <div className={`card sub`}>家人列表没读回来——检查一下网络或服务是不是停了。</div> : null}
      {!isPending && !isError && members.length === 0 ? (
        <div className="card sub">还没有家人——种子数据随迁移落库，检查一下数据库。</div>
      ) : null}

      <div className={styles.list}>
        {members.map((member) => (
          <MemberCard key={member.id} member={member} isCurrent={member.id === current?.id} />
        ))}
      </div>
    </div>
  );
}

function MemberCard({ member, isCurrent }: { member: Member; isCurrent: boolean }) {
  const { switchIdentity } = useIdentity();
  const update = useUpdateMember();
  const [error, setError] = useState<string | undefined>(undefined);

  const save = (patch: ProfilePatch): void => {
    setError(undefined);
    update.mutate(
      { id: member.id, patch },
      { onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败') },
    );
  };

  const avoidIds = member.avoid.map((entry) => entry.ingredientId);
  const loves = member.loves;

  return (
    <div className={styles.memberCard} data-testid={`member-${member.id}`}>
      <div className="spread">
        <div className={styles.who}>
          <span className={styles.avatar} aria-hidden="true">
            {member.emoji}
          </span>
          <span>
            <b>{member.name}</b>
            {member.isCook ? <span className="badge acc"> 掌勺者</span> : null}
            {isCurrent ? (
              <span className="badge ok" data-testid={`member-current-${member.id}`}>
                当前身份
              </span>
            ) : null}
            <div className="sub" data-testid={`member-subtitle-${member.id}`}>
              {memberSubtitle(member, new Date())}
            </div>
          </span>
        </div>
        {/* 头部切换器是常驻入口；这里再给一个一拍的——「点头像即切」 */}
        <button
          type="button"
          className={isCurrent ? `btn ghost ${styles.switchButton}` : `btn ${styles.switchButton}`}
          disabled={isCurrent}
          data-testid={`member-switch-${member.id}`}
          onClick={() => switchIdentity(member.id)}
        >
          {isCurrent ? '✓ 当前身份' : '切为此人'}
        </button>
      </div>

      <div className={styles.blockLabel}>忌口（硬排除）</div>
      <div className={styles.entries} data-testid={`${member.id}-avoid-entries`}>
        {member.avoid.length === 0 ? <span className="sub">无</span> : null}
        {member.avoid.map((entry) => (
          <EntryChip
            key={entry.ingredientId}
            testId={`${member.id}-avoid-entry-${entry.ingredientId}`}
            removeTestId={`${member.id}-avoid-remove-${entry.ingredientId}`}
            variant="avoid"
            name={entry.name}
            onRemove={() => save({ avoid: avoidIds.filter((id) => id !== entry.ingredientId) })}
          />
        ))}
      </div>
      <IngredientPicker
        memberId={member.id}
        variant="avoid"
        label="忌口（硬排除）"
        existing={new Set(avoidIds)}
        onAdd={(ingredientId) => save({ avoid: [...avoidIds, ingredientId] })}
      />

      <div className={styles.blockLabel}>爱吃（软加分 · 食材或某道菜）</div>
      <div className={styles.entries} data-testid={`${member.id}-loves-entries`}>
        {loves.length === 0 ? <span className="sub">无</span> : null}
        {loves.map((entry) => (
          <EntryChip
            key={`${entry.kind}:${entry.id}`}
            testId={`${member.id}-loves-entry-${entry.id}`}
            removeTestId={`${member.id}-loves-remove-${entry.id}`}
            variant="loves"
            name={entry.name}
            kind={entry.kind}
            onRemove={() => save({ loves: loves.filter((item) => !(item.kind === entry.kind && item.id === entry.id)) })}
          />
        ))}
      </div>
      <LovesPicker
        memberId={member.id}
        existing={new Set(loves.map((entry) => `${entry.kind}:${entry.id}`))}
        onAdd={(target) => save({ loves: [...loves.map(toTarget), target] })}
      />

      <div className={styles.blockLabel}>出生年月{member.kind === 'child' ? '（小孩必填 · 份量按年龄分带折算）' : '（选填）'}</div>
      <BirthMonthField member={member} onSave={(birthMonth) => save({ birthMonth })} />

      {update.isPending ? <div className={`sub ${styles.saved}`}>保存中…</div> : null}
      {error ? (
        <div className={styles.error} data-testid={`member-error-${member.id}`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** 把带名字的爱吃条目退回成编辑入参（名字由服务端现读字典/菜谱库，不接受客户端自报） */
function toTarget(entry: LoveEntry): LoveTarget {
  return { kind: entry.kind, id: entry.id };
}

function EntryChip({
  testId,
  removeTestId,
  variant,
  name,
  kind,
  onRemove,
}: {
  testId: string;
  removeTestId: string;
  variant: 'avoid' | 'loves';
  name: string;
  /** 爱吃的条目粒度：菜的话给个标记，家人一眼看得出这是「一道菜」而不是「一种食材」 */
  kind?: 'ingredient' | 'recipe';
  onRemove(): void;
}) {
  return (
    <span className={`${styles.entry} ${styles[variant]}`} data-testid={testId}>
      {variant === 'avoid' ? '🚫' : '❤'} {name}
      {kind === 'recipe' ? <span className={styles.recipeTag}>菜</span> : null}
      <button type="button" className={styles.remove} aria-label={`删掉 ${name}`} data-testid={removeTestId} onClick={onRemove}>
        ✕
      </button>
    </span>
  );
}

/** 忌口挑食材：只指向字典（硬过滤的基数），搜规范名或别名 */
function IngredientPicker({
  memberId,
  variant,
  label,
  existing,
  onAdd,
}: {
  memberId: string;
  variant: string;
  label: string;
  existing: Set<string>;
  onAdd(ingredientId: string): void;
}) {
  const [query, setQuery] = useState('');
  const suggestions = (useIngredients(query).data ?? []).filter((item) => !existing.has(item.id));
  const visible = suggestions.slice(0, 6);
  const testIdPrefix = `${memberId}-${variant}`;

  const add = (ingredient: Ingredient): void => {
    onAdd(ingredient.id);
    setQuery('');
  };

  return (
    <>
      <div className={styles.addRow}>
        <input
          className={styles.input}
          type="text"
          value={query}
          placeholder="搜食材（规范名或别名，如 西红柿）"
          aria-label={`给${label}加一条`}
          data-testid={`${testIdPrefix}-input`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = visible[0];
            if (event.key === 'Enter' && first) add(first);
          }}
        />
        <button
          type="button"
          className="btn ghost"
          // 先搜再选：空搜索时不让「加」默默把字典里第一个食材塞进去
          disabled={query.trim() === '' || visible.length === 0}
          data-testid={`${testIdPrefix}-add`}
          onClick={() => {
            const first = visible[0];
            if (first) add(first);
          }}
        >
          加
        </button>
      </div>

      {query.trim() !== '' && visible.length > 0 ? (
        <div className={styles.suggestions}>
          {visible.map((ingredient) => (
            <button
              key={ingredient.id}
              type="button"
              className={styles.suggestion}
              data-testid={`${testIdPrefix}-suggestion-${ingredient.id}`}
              onClick={() => add(ingredient)}
            >
              {ingredient.name}
              {ingredient.aliases.length > 0 ? `（${ingredient.aliases[0]}）` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * 爱吃挑条目：**食材或某道菜**（总纲 §2.9 的混合粒度）。
 * 一个输入框同时搜两边：家人说「红烧肉」说的是菜，说「土豆」说的是食材，让界面去分辨而不是让家人先选类别。
 */
function LovesPicker({
  memberId,
  existing,
  onAdd,
}: {
  memberId: string;
  existing: Set<string>;
  onAdd(target: LoveTarget): void;
}) {
  const [query, setQuery] = useState('');
  const testIdPrefix = `${memberId}-loves`;

  const ingredients = useIngredients(query).data ?? [];
  const recipesQuery = useRecipes('all');
  const keyword = query.trim();
  const recipes = (recipesQuery.data ?? []).filter(
    (recipe) =>
      keyword !== '' &&
      !existing.has(`recipe:${recipe.id}`) &&
      (recipe.name.includes(keyword) || recipe.aliases.some((alias) => alias.includes(keyword))),
  );

  const options: { key: string; id: string; name: string; kind: 'ingredient' | 'recipe'; note?: string }[] = [
    ...ingredients
      .filter((item) => !existing.has(`ingredient:${item.id}`))
      .map((item) => ({
        key: `ingredient:${item.id}`,
        id: item.id,
        name: item.name,
        kind: 'ingredient' as const,
        note: item.aliases[0],
      })),
    ...recipes.map((recipe: Recipe) => ({
      key: `recipe:${recipe.id}`,
      id: recipe.id,
      name: recipe.name,
      kind: 'recipe' as const,
      note: '家常菜',
    })),
  ].slice(0, 6);

  const add = (option: (typeof options)[number]): void => {
    onAdd({ kind: option.kind, id: option.id });
    setQuery('');
  };

  return (
    <>
      <div className={styles.addRow}>
        <input
          className={styles.input}
          type="text"
          value={query}
          placeholder="搜食材或菜名（如 土豆 / 红烧排骨）"
          aria-label={`给${memberId}的爱吃加一条`}
          data-testid={`${testIdPrefix}-input`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = options[0];
            if (event.key === 'Enter' && first) add(first);
          }}
        />
        <button
          type="button"
          className="btn ghost"
          disabled={query.trim() === '' || options.length === 0}
          data-testid={`${testIdPrefix}-add`}
          onClick={() => {
            const first = options[0];
            if (first) add(first);
          }}
        >
          加
        </button>
      </div>

      {query.trim() !== '' && options.length > 0 ? (
        <div className={styles.suggestions}>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className={styles.suggestion}
              data-testid={`${testIdPrefix}-suggestion-${option.id}`}
              onClick={() => add(option)}
            >
              {option.name}
              {option.note ? `（${option.note}）` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function BirthMonthField({ member, onSave }: { member: Member; onSave(birthMonth: string): void }) {
  // 本地草稿：input[type=month] 中途的不完整值不往外发（服务端只收 YYYY-MM）
  const [draft, setDraft] = useState(member.birthMonth ?? '');

  return (
    <div className={styles.birthRow}>
      <input
        className={styles.input}
        type="month"
        value={draft}
        min="1900-01"
        max="2100-12"
        aria-label={`${member.name}的出生年月`}
        data-testid={`member-birth-${member.id}`}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (/^\d{4}-(0[1-9]|1[0-2])$/.test(next)) onSave(next);
        }}
      />
    </div>
  );
}
