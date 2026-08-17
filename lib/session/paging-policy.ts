/** 长会话分页默认开启；仅显式设 0 时回滚为完整历史。 */
export function isSessionPagingEnabled(value = process.env.DEERHUX_SESSION_PAGING): boolean {
  return value !== "0";
}
