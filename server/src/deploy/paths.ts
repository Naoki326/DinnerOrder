/**
 * 部署产物的路径与命名约定（唯一一处）。
 *
 * 为什么单拎出来：`install`/`uninstall`/`backup`/装载器四条路都要拼同一批路径，
 * 各写一遍必然漂移（改一处忘一处 → 卸载删不掉、热备写错目录）。这里只有纯函数，
 * 不碰文件系统，测试可以直接断言产出的字符串。
 *
 * 约定（与 spec §7 与 `.gitignore` 一致）：
 *   * 热备落 `backups/`，文件名 `dinner-YYYY-MM-DD.db`——**日期在文件名里**，
 *     「按日滚动保留」因此是「同一日期重复跑只覆盖那一份」，不是「每跑一次多一份」。
 *   * 日志落 `data/logs/`，随 `.env` 一起排除出双备份通道（DEBUG 调试落盘也在那儿）。
 */
import path from 'node:path';

/** 热备文件名前缀（按日滚动保留的键） */
const BACKUP_PREFIX = 'dinner-';
const BACKUP_SUFFIX = '.db';

/** 热备所属的日期标签（家庭时区的今天，'YYYY-MM-DD'） */
export function backupFileName(today: string): string {
  return `${BACKUP_PREFIX}${today}${BACKUP_SUFFIX}`;
}

/**
 * 从文件名解析出它的日期标签；不是本约定命名的文件返回 undefined。
 *
 * 滚动保留**只认**这个形状：`backups/` 是数据目录，用户可能往里放别的东西
 * （手工备份、说明文件），删别人的文件比留着几份旧备份危险得多。
 */
export function backupFileDate(fileName: string): string | undefined {
  if (!fileName.startsWith(BACKUP_PREFIX) || !fileName.endsWith(BACKUP_SUFFIX)) return undefined;
  const date = fileName.slice(BACKUP_PREFIX.length, fileName.length - BACKUP_SUFFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

/** 热备目录（相对仓库根） */
export function backupsDir(root: string): string {
  return path.join(root, 'backups');
}

/** 日志目录（相对仓库根） */
export function logsDir(root: string): string {
  return path.join(root, 'data', 'logs');
}

/** launchd 的 LaunchAgent 标签，install 与 uninstall 共用（写错一个字母就卸载不掉） */
export const LAUNCHD_LABEL = 'com.naoki.dinnerorder';

/** LaunchAgent plist 在 `~/Library/LaunchAgents/` 下的文件名 */
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;
