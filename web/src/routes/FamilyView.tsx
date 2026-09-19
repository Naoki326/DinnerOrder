import { useState } from 'react';
import { useIngredients, type Ingredient } from '../api/ingredients';
import { useUpdateMember, type Member, type ProfileEntry, type ProfilePatch } from '../api/members';
import { useIdentity } from '../identity';
import { memberSubtitle } from '../components/memberLabel';
import styles from './FamilyView.module.css';

/**
 * 家人画像（总纲 §2.9）：大人/小孩、男/女、出生年月、忌口[]、爱吃[]。
 *
 * 两处交互按「建模不对称」来：
 *   * 忌口是**硬过滤**——条目只能指向食材字典（推荐期命中即排除，含隐性忌口展开）；
 *   * 爱吃是**软加分**——条目可以是食材也可以是具体菜；菜粒度等 #15 的菜谱表接通，
 *     本票先在界面上说明，不发明一个存不进库的入口。
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
          忌口从推荐里排除（硬过滤）；爱吃给推荐加分（软加分）。条目都指向食材字典。
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

  const entryIds = (entries: ProfileEntry[]): string[] => entries.map((entry) => entry.ingredientId);

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

      <EntryBlock
        memberId={member.id}
        label="忌口（硬排除）"
        variant="avoid"
        entries={member.avoid}
        onRemove={(ingredientId) => save({ avoid: entryIds(member.avoid).filter((id) => id !== ingredientId) })}
        onAdd={(ingredientId) => save({ avoid: [...entryIds(member.avoid), ingredientId] })}
      />

      <EntryBlock
        memberId={member.id}
        label="爱吃（软加分）"
        variant="loves"
        entries={member.loves}
        onRemove={(ingredientId) => save({ loves: entryIds(member.loves).filter((id) => id !== ingredientId) })}
        onAdd={(ingredientId) => save({ loves: [...entryIds(member.loves), ingredientId] })}
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

type EntryVariant = 'avoid' | 'loves';

function EntryBlock({
  memberId,
  label,
  variant,
  entries,
  onAdd,
  onRemove,
}: {
  memberId: string;
  label: string;
  variant: EntryVariant;
  entries: ProfileEntry[];
  onAdd(ingredientId: string): void;
  onRemove(ingredientId: string): void;
}) {
  const [query, setQuery] = useState('');
  // 已在本清单里的食材不再作为可选项（清单是集合）
  const existing = new Set(entries.map((entry) => entry.ingredientId));
  const suggestions = (useIngredients(query).data ?? []).filter((item) => !existing.has(item.id));
  const visible = suggestions.slice(0, 6);
  const testIdPrefix = `${memberId}-${variant}`;

  const add = (ingredient: Ingredient): void => {
    onAdd(ingredient.id);
    setQuery('');
  };

  return (
    <div>
      <div className={styles.blockLabel}>{label}</div>
      <div className={styles.entries} data-testid={`${testIdPrefix}-entries`}>
        {entries.length === 0 ? <span className="sub">无</span> : null}
        {entries.map((entry) => (
          <span key={entry.ingredientId} className={`${styles.entry} ${styles[variant]}`} data-testid={`${testIdPrefix}-entry-${entry.ingredientId}`}>
            {variant === 'avoid' ? '🚫' : '❤'} {entry.name}
            <button
              type="button"
              className={styles.remove}
              aria-label={`删掉 ${entry.name}`}
              data-testid={`${testIdPrefix}-remove-${entry.ingredientId}`}
              onClick={() => onRemove(entry.ingredientId)}
            >
              ✕
            </button>
          </span>
        ))}
      </div>

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
    </div>
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
