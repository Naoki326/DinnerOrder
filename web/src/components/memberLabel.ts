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

function ageLabel(member: Member, now: Date): string {
  if (!member.birthMonth) return '年龄待补';
  const [year, month] = member.birthMonth.split('-').map(Number) as [number, number];
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month) age -= 1;
  return `${age} 岁`;
}
