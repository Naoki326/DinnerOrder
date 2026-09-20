import { useEffect, useState } from 'react';
import { useIngredients, type Ingredient } from '../api/ingredients';
import { useRecipes, type Recipe } from '../api/recipes';
import {
  useCreateMember,
  useDeleteMember,
  useUpdateMember,
  type LoveEntry,
  type LoveTarget,
  type Member,
  type ProfilePatch,
} from '../api/members';
import { useIdentity } from '../identity';
import { ageInYears, memberSubtitle } from '../components/memberLabel';
import styles from './FamilyView.module.css';

/**
 * 家人画像（总纲 §2.9）：大人/小孩、男/女、出生年月、忌口[]、爱吃[]。
 *
 * 两处交互按「建模不对称」来：
 *   * 忌口是**硬过滤**——条目只能指向食材字典（推荐期命中即排除，含隐性忌口展开）；
 *   * 爱吃是**软加分**——条目可以是食材也可以是具体菜（#15 接通了菜粒度的存取）。
 * 改动即时落库（手机上改完即生效），不做「保存」按钮那种容易忘按的中间态。
 *
 * 家人管理（本票）：顶部可**新增**（一级表单，填完即存）、每张卡可**删除**（软删除，带确认）。
 */
export function FamilyView() {
  const { members, current, isPending, isError } = useIdentity();
  const [adding, setAdding] = useState(false);

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
        {/* 新增入口就在家人页顶部（一级表单，不是分步向导）：点开填写即存 */}
        <button
          type="button"
          className={`btn block ${styles.addButton}`}
          data-testid="add-member"
          aria-expanded={adding}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? '收起' : '+ 新增家人'}
        </button>
      </div>

      {adding ? <NewMemberForm onClose={() => setAdding(false)} /> : null}

      {isPending ? <div className={`card sub`}>读取中…</div> : null}
      {isError ? <div className={`card sub`}>家人列表没读回来——检查一下网络或服务是不是停了。</div> : null}
      {!isPending && !isError && members.length === 0 ? (
        <div className="card sub">还没有家人——点上面的「+ 新增家人」把家里人加进来。</div>
      ) : null}

      <div className={styles.list}>
        {members.map((member) => (
          <MemberCard key={member.id} member={member} isCurrent={member.id === current?.id} />
        ))}
      </div>
    </div>
  );
}

/** 头像的快速选择：家人多半就点这几个（也可以自己打一个 emoji） */
const EMOJI_PICKS = ['👩', '👨', '👵', '👴', '👦', '👧', '👶', '🧑'] as const;

const BIRTH_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 新增家人（本票）：一级表单——名字 + 头像 + 大人/小孩 + 性别都必填，小孩再加出生年月。
 *
 * 为什么大人也要必填性别（用户已确认）：**6–17 岁小孩的折算系数按性别相差 14%**
 * （6–8 岁：男 0.756 / 女 0.861），而库里 `gender` 是 NOT NULL。不靠默认值，录入时就问清楚；
 * 两栏必填比「一栏必填 + 一栏悄悄取默认」更好解释。
 *
 * 忌口/爱吃不上表（用户已确认：可选/后补）——新增后在同一张卡上用现有的画像编辑入口加，
 * 那套 UI 已经是「改完即存」，不重做也不需要「保存」按钮。掌勺者标记同样不在表单里（用户没要求）。
 */
function NewMemberForm({ onClose }: { onClose(): void }) {
  const create = useCreateMember();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [kind, setKind] = useState<'adult' | 'child' | null>(null);
  const [gender, setGender] = useState<'male' | 'female' | null>(null);
  const [birthMonth, setBirthMonth] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  /**
   * 提交前的本地校验（服务端还有一道，两道都要有）：
   * 客户端这一道是为了**当场给一句人话**，不为了「拦住」——绕过界面直接打接口的路径由服务端兜底。
   * 校验顺序按表单从上到下，报出来的永远是第一个没填对的那一栏。
   */
  const validate = (): string | undefined => {
    if (name.trim() === '') return '名字不能为空';
    if (emoji.trim() === '') return '选一个头像（也可以自己打一个 emoji）';
    if (kind === null) return '选一下是大人还是小孩';
    if (gender === null) return '选一下性别（小孩的份量按性别分带折算）';
    // 小孩必须有出生年月：份量按年龄分带查表，没有它就没有依据（001 的 CHECK 也这么要求）
    if (kind === 'child' && !BIRTH_MONTH_PATTERN.test(birthMonth)) {
      return '小孩必须有出生年月（份量按年龄分带折算）';
    }
    return undefined;
  };

  const submit = (): void => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    create.mutate(
      {
        name,
        emoji,
        kind: kind!,
        gender: gender!,
        // 大人留空 = null（画像里「大人可空」是合法状态，不是没填）
        birthMonth: birthMonth === '' ? null : birthMonth,
      },
      {
        onSuccess: () => onClose(),
        // 服务端的错因（400 带 issues，readErrorDetail 已翻成中文）原样上屏
        onError: (cause) => setError(cause instanceof Error ? cause.message : '新增失败'),
      },
    );
  };

  return (
    <div className={`card ${styles.form}`} data-testid="new-member-form">
      <div className={styles.blockLabel}>新增家人</div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="new-member-name">
          名字（必填）
        </label>
        <input
          id="new-member-name"
          className={styles.input}
          type="text"
          value={name}
          placeholder="如 姥姥"
          data-testid="new-member-name"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="new-member-emoji">
          头像（必填 · emoji）
        </label>
        <input
          id="new-member-emoji"
          className={styles.input}
          type="text"
          value={emoji}
          placeholder="点下面的，或自己打一个"
          data-testid="new-member-emoji"
          onChange={(event) => setEmoji(event.target.value)}
        />
        <div className={styles.emojiRow}>
          {EMOJI_PICKS.map((pick) => (
            <button
              key={pick}
              type="button"
              className={emoji === pick ? `${styles.emojiPick} ${styles.emojiPickOn}` : styles.emojiPick}
              aria-label={`用 ${pick} 作头像`}
              aria-pressed={emoji === pick}
              data-testid={`new-member-emoji-${pick}`}
              onClick={() => setEmoji(pick)}
            >
              {pick}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>大人 / 小孩（必填）</div>
        <div className={styles.choices}>
          <Choice
            testId="new-member-kind-adult"
            label="大人"
            on={kind === 'adult'}
            onClick={() => setKind('adult')}
          />
          <Choice
            testId="new-member-kind-child"
            label="小孩"
            on={kind === 'child'}
            onClick={() => setKind('child')}
          />
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldLabel}>性别（必填 · 小孩的份量按它分带）</div>
        <div className={styles.choices}>
          <Choice
            testId="new-member-gender-male"
            label="男"
            on={gender === 'male'}
            onClick={() => setGender('male')}
          />
          <Choice
            testId="new-member-gender-female"
            label="女"
            on={gender === 'female'}
            onClick={() => setGender('female')}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="new-member-birth">
          出生年月{kind === 'child' ? '（小孩必填）' : '（选填）'}
        </label>
        <input
          id="new-member-birth"
          className={styles.input}
          type="month"
          value={birthMonth}
          min="1900-01"
          max="2100-12"
          data-testid="new-member-birth"
          onChange={(event) => setBirthMonth(event.target.value)}
        />
      </div>

      {error ? (
        <div className={styles.error} data-testid="new-member-error">
          {error}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <button
          type="button"
          className="btn block"
          data-testid="new-member-submit"
          disabled={create.isPending}
          onClick={submit}
        >
          {create.isPending ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn ghost block"
          data-testid="new-member-cancel"
          disabled={create.isPending}
          onClick={onClose}
        >
          取消
        </button>
      </div>
    </div>
  );
}

/** 二选一的按钮（大人/小孩、男/女）：手机上一拍就选中，选中后台面上看得出来 */
function Choice({ testId, label, on, onClick }: { testId: string; label: string; on: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className={on ? `${styles.choice} ${styles.choiceOn}` : styles.choice}
      data-testid={testId}
      aria-pressed={on}
      onClick={onClick}
    >
      {on ? '✓ ' : ''}
      {label}
    </button>
  );
}

function MemberCard({ member, isCurrent }: { member: Member; isCurrent: boolean }) {
  const { switchIdentity } = useIdentity();
  const update = useUpdateMember();
  const remove = useDeleteMember();
  const [error, setError] = useState<string | undefined>(undefined);
  // 删除要有确认（不能一点就删）：两步式——先点「删除」，卡片上就地展开确认条，再点一次才真的删。
  // 用内联确认而不是 window.confirm：手机上弹窗会被浏览器拦掉或长得不像这个 app，
  // 而且确认文案要能写清「历史保留」这件事（删除是软删除，家人会问「那以前吃的还算吗」）。
  const [confirming, setConfirming] = useState(false);

  const save = (patch: ProfilePatch): void => {
    setError(undefined);
    update.mutate(
      { id: member.id, patch },
      { onError: (cause) => setError(cause instanceof Error ? cause.message : '保存失败') },
    );
  };

  const doDelete = (): void => {
    setError(undefined);
    remove.mutate(member.id, {
      onError: (cause) => setError(cause instanceof Error ? cause.message : '删除失败'),
      // 成功后不必手动作什么：`useDeleteMember` invalidate 了 `['members']`，
      // 这一张卡随新列表一起消失（当前身份若正是他，identity.tsx 的兜底会回退到掌勺者）
    });
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
            // testid 带上 kind（#21）：member_loves 是混合粒度（食材**或**菜），只用 id 时
            // 一道菜谱 id 与一个食材 id 相同就会撞车（strict 模式直接报错）。
            testId={`${member.id}-loves-entry-${entry.kind}-${entry.id}`}
            removeTestId={`${member.id}-loves-remove-${entry.kind}-${entry.id}`}
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

      {/* 基本资料（名字 / 头像 / 性别）：原先这三栏只在新增时填得了，之后再也改不了——
          而性别不是标注：6–17 岁小孩的份量系数按性别相差约 14%（WS/T 554 表 1）。
          录错了只能删了重建，而重建会丢掉这位家人的忌口/爱吃/餐史归属。
          三个字段都「改完即存」（与这一页其余编辑同一手感），不另设保存按钮。 */}
      <ProfileBasics member={member} onSave={(patch) => save(patch)} />

      {/* 掌勺者标记（本票起可改）：语义是「家里**通常**谁做菜」——是缺省值，不是权限位。
          每一餐的掌勺者在餐槽编辑器里单独指定（`SlotView`），这里改的是开 app 的缺省身份
          与新餐槽的缺省掌勺者。所以文案不说“谁做菜”，说清是「通常」。 */}
      <div className={styles.blockLabel}>掌勺者（家里通常谁做菜 · 缺省值）</div>
      <div className={styles.entries}>
        <button
          type="button"
          className={member.isCook ? `${styles.entry} ${styles.loves}` : styles.entry}
          data-testid={`member-cook-${member.id}`}
          aria-pressed={member.isCook}
          onClick={() => save({ isCook: !member.isCook })}
        >
          {member.isCook ? '👨‍🍳 是家里的掌勺者' : '也算掌勺者'}
        </button>
        <div className="sub" style={{ marginTop: 6 }} data-testid={`member-cook-hint-${member.id}`}>
          {member.isCook
            ? '开 app 默认用这个身份；新定的餐也默认由他掌勺（每一餐都能单独改）。'
            : '勾上它，开 app 会优先用这个身份、新定的餐也默认算他掌勺。'}
        </div>
      </div>

      {/* 删除（本票）：破坏性操作，两步确认。文案说清是**软删除**——家人会问「那以前吃的还算吗」 */}
      <div className={styles.dangerRow}>
        {confirming ? (
          <div className={styles.confirm} data-testid={`member-delete-confirm-${member.id}`}>
            <div className="sub">
              把 {member.name} 从家人列表移除？他不会再进用餐者名单，忌口与爱吃也随之失效；
              吃过那些餐的历史与反馈都保留。
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={`btn ${styles.dangerButton}`}
                data-testid={`member-delete-confirmed-${member.id}`}
                disabled={remove.isPending}
                onClick={doDelete}
              >
                {remove.isPending ? '删除中…' : '确认删除'}
              </button>
              <button
                type="button"
                className="btn ghost"
                data-testid={`member-delete-cancel-${member.id}`}
                disabled={remove.isPending}
                onClick={() => setConfirming(false)}
              >
                不删了
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={styles.dangerLink}
            data-testid={`member-delete-${member.id}`}
            onClick={() => setConfirming(true)}
          >
            删除这位家人
          </button>
        )}
      </div>

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
              // kind 带上（与 EntryChip 同一理由：同一个 id 可能既是食材又是菜）
              data-testid={`${testIdPrefix}-suggestion-${option.kind}-${option.id}`}
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

/**
 * 这位家人是否已进入**分性别**的份量档（学龄期 6 岁起）。
 *
 * 用来决定那句提示怎么写：同一页面上一句话既要说清「这个字段为什么重要」，
 * 又不该对尚在学龄前的孩子说「你选错就偏了」（实际还没到那个档，选错真的不影响读数）。
 * 年龄算法共用 `memberLabel` 那一份，不在这里重算一遍。
 */
function banded(member: Member): boolean {
  if (member.kind !== 'child' || member.birthMonth === null) return false;
  const age = ageInYears(member.birthMonth, new Date());
  return age >= 6;
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

/**
 * 基本资料：名字 / 头像 / 性别。
 *
 * **改完即存，不设保存按钮**——与这一页其余编辑（忌口/爱吃/出生年月/掌勺者）同一手感，
 * 家人不必学两套交互。名字与头像是**本地草稿**（打字中途不该每敲一个字发一次请求），
 * 失焦时才提交；性别是二选一，点一下就该生效。
 *
 * 为什么值得给它一块 UI：这三栏原先只在新增家人的表单里，之后**永远改不了**。
 * 名字打错字、头像挑错、性别录反都是迟早的事，而唯一出路「删了重建」会连带丢掉这位家人的
 * 忌口/爱吃与餐史归属（删除是软删除，但那是绕路，不是替代）。
 */
function ProfileBasics({ member, onSave }: { member: Member; onSave(patch: ProfilePatch): void }) {
  // 草稿与「已提交值」分开：输入中途不发请求，失焦时若真的变了才提交
  const [name, setName] = useState(member.name);
  const [emoji, setEmoji] = useState(member.emoji);

  // 服务端数据变了（别处改过/切换了当前身份）就把草稿同步回来，避免显示陈旧值
  useEffect(() => {
    setName(member.name);
    setEmoji(member.emoji);
  }, [member.name, member.emoji]);

  const commitName = (): void => {
    const next = name.trim();
    // 空名字就地退回原值：服务端也会拒（同一口径），但没必要为此打一趟请求
    if (next === '' || next === member.name) {
      setName(member.name);
      return;
    }
    onSave({ name: next });
  };

  return (
    <>
      <div className={styles.blockLabel}>基本资料（名字 / 头像 / 性别）</div>
      <div className={styles.basicsRow}>
        <input
          className={styles.input}
          type="text"
          value={name}
          maxLength={20}
          aria-label={`${member.name}的名字`}
          data-testid={`member-name-input-${member.id}`}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <input
          className={styles.emojiInput}
          type="text"
          value={emoji}
          maxLength={4}
          aria-label={`${member.name}的头像`}
          data-testid={`member-emoji-input-${member.id}`}
          onChange={(event) => setEmoji(event.target.value)}
          onBlur={() => {
            const next = emoji.trim();
            if (next === '' || next === member.emoji) {
              setEmoji(member.emoji);
              return;
            }
            onSave({ emoji: next });
          }}
        />
      </div>
      {/* 头像快选：家人多半就点这几个（与新增表单同一组，不另维护一份） */}
      <div className={styles.emojiRow}>
        {EMOJI_PICKS.map((pick) => (
          <button
            key={pick}
            type="button"
            className={pick === member.emoji ? `${styles.emojiPick} ${styles.emojiPickOn}` : styles.emojiPick}
            data-testid={`member-emoji-${member.id}-${pick}`}
            aria-label={`把头像换成 ${pick}`}
            aria-pressed={pick === member.emoji}
            onClick={() => {
              setEmoji(pick);
              onSave({ emoji: pick });
            }}
          >
            {pick}
          </button>
        ))}
      </div>
      <div className={styles.entries} style={{ marginTop: 8 }}>
        <button
          type="button"
          className={member.gender === 'male' ? `${styles.entry} ${styles.loves}` : styles.entry}
          data-testid={`member-gender-male-${member.id}`}
          aria-pressed={member.gender === 'male'}
          onClick={() => onSave({ gender: 'male' })}
        >
          👦 男孩 / 男士
        </button>
        <button
          type="button"
          className={member.gender === 'female' ? `${styles.entry} ${styles.loves}` : styles.entry}
          data-testid={`member-gender-female-${member.id}`}
          aria-pressed={member.gender === 'female'}
          onClick={() => onSave({ gender: 'female' })}
        >
          👧 女孩 / 女士
        </button>
        <span className="sub" data-testid={`member-gender-hint-${member.id}`}>
          {banded(member)
            ? '6 岁起份量按性别分带折算，这里选错会让克数一直偏。'
            : '6–17 岁的份量按性别分带折算（现在还没到这个年龄带，选错不影响读数）。'}
        </span>
      </div>
    </>
  );
}
