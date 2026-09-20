import type { Member } from '../api/members';

/**
 * 家人列表/切换器上的副标题：「大人」或「小孩 · N 岁」。
 *
 * 年龄这里只用出生年月粗算给**展示**用；份量折算的分带判定在服务端按注入时钟现算
 * （#16 份量引擎，spec S3 的 6–10/11–13/14–17 岁分带），展示与判定不走同一条路径。
 */
export function memberSubtitle(member: Member, now: Date = new Date()): string {
  const who = member.kind === 'adult' ? '大人' : `小孩 · ${ageLabel(member, now)}`;
  return `${who} · ${member.gender === 'male' ? '男' : '女'}`;
}

/**
 * 出生年月 → 周岁（按当前月份是否过了生日算）。
 *
 * 导出是因为别处也要用它做**展示层**判断（家人卡上「是否已进分性别的份量档」那句话）：
 * 另算一遍会让两处对「几岁」得出不同答案，而这类偏差最难发现（页面自己跟自己不一致）。
 */
export function ageInYears(birthMonth: string, now: Date = new Date()): number {
  const [year, month] = birthMonth.split('-').map(Number) as [number, number];
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month) age -= 1;
  return age;
}

function ageLabel(member: Member, now: Date): string {
  if (!member.birthMonth) return '年龄待补';
  return `${ageInYears(member.birthMonth, now)} 岁`;
}
