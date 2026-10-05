import type { ShutterState } from '../core/types';

/**
 * 以快门 ID 为键的记录（快门表 / 锁定表）操作。
 *
 * 快门 ID 允许为 __proto__ / constructor / toString / OR 等任意非空、
 * 非保留字标识，因此所有按键读写都必须避开原型链：
 * - 成员判断用 hasOwnProperty（而非 in，后者会把继承属性误判为已登记）；
 * - 建表用 Object.fromEntries / 对象字面量计算属性（均落为自有数据属性，
 *   不会触发 Object.prototype 的 __proto__ 访问器）。
 * 这样特殊 ID 与普通 ID 在界面状态、锁数量统计与导出中行为完全一致。
 */

/** 该快门是否已作为自有属性登记在记录中（不看原型链）。 */
export function hasShutterKey(
  rec: Record<string, ShutterState>,
  id: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(rec, id);
}

/** 初始快门表：每个 ID 都是独立自有条目，全部 CLOSED。 */
export function initialTable(ids: string[]): Record<string, ShutterState> {
  return Object.fromEntries(
    ids.map((id): [string, ShutterState] => [id, 'CLOSED']),
  );
}

/** 切换锁定：未锁定 → 锁定到该快门当前表值；已锁定 → 解锁。 */
export function toggleLock(
  locks: Record<string, ShutterState>,
  id: string,
  current: ShutterState,
): Record<string, ShutterState> {
  if (hasShutterKey(locks, id)) {
    const next = { ...locks };
    delete next[id];
    return next;
  }
  // 计算属性键：即使 id 为 __proto__ 也写为自有数据属性
  return { ...locks, [id]: current };
}

/** 已锁定的快门在 OPEN/CLOSED 间切换锁定值；未锁定则原样返回。 */
export function cycleLockState(
  locks: Record<string, ShutterState>,
  id: string,
): Record<string, ShutterState> {
  if (!hasShutterKey(locks, id)) return locks;
  return { ...locks, [id]: locks[id] === 'OPEN' ? 'CLOSED' : 'OPEN' };
}
