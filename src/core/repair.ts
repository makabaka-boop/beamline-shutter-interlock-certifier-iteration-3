import type { LockRepair, ShutterState, Workspace } from './types';
import { isSatisfiable, solveWorkspace } from './sat';
import { sortByUtf8 } from './utf8';

/**
 * 仅当当前锁定数不超过该值时才求精确最少撤销数：
 * 需要枚举锁定子集（2^n），8 把锁最多 256 个子集，代价可控。
 */
export const MAX_REPAIR_LOCKS = 8;

/** 按字典序生成 items 的所有 k 元组合（items 须已按目标序排好）。 */
function* combinations<T>(items: T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** 从锁定表中移除指定 ID，返回新表（fromEntries 保证 __proto__ 等键落为自有属性）。 */
function removeLocks(
  locks: Record<string, ShutterState>,
  remove: ReadonlySet<string>,
): Record<string, ShutterState> {
  return Object.fromEntries(
    Object.entries(locks).filter(([id]) => !remove.has(id)),
  );
}

/**
 * 锁定修复建议：规则与快门表保持不变，只考虑「撤销若干临时锁定」。
 *
 * - 全部解锁后仍无解 → 规则自身冲突，明确报告，不提供任何建议；
 * - 锁定数超过 MAX_REPAIR_LOCKS → 不做指数级枚举，仅报告数量；
 * - 否则按撤销数 k 从小到大枚举锁定子集：锁定 ID 先按 UTF-8 字节序排列，
 *   同 k 内组合按字典序生成，第一个恢复可行的子集即精确最少撤销；
 *   并列（同为最少）时该枚举序保证选中「排序后 ID 清单字典序最小」者。
 *   撤销后的完整方案由原 2-SAT 求解器（solveWorkspace）给出。
 */
export function suggestLockRepair(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
): LockRepair {
  // 全部解锁仍无解：规则自身冲突，任何撤销组合都恢复不了（撤销只会减少约束，
  // 全部撤销已是最弱约束），此时给建议就是假建议。
  if (!isSatisfiable(workspace, {})) {
    return { kind: 'rules-conflict' };
  }

  const lockedIds = sortByUtf8(Object.keys(locks), (id) => id);
  if (lockedIds.length > MAX_REPAIR_LOCKS) {
    return { kind: 'too-many-locks', count: lockedIds.length };
  }

  for (let k = 0; k <= lockedIds.length; k++) {
    for (const remove of combinations(lockedIds, k)) {
      const remaining = removeLocks(locks, new Set(remove));
      if (!isSatisfiable(workspace, remaining)) continue;
      const outcome = solveWorkspace(workspace, remaining);
      if (outcome.kind !== 'sat') {
        // 与 isSatisfiable 共用同一实现，不可达；防御性跳过
        continue;
      }
      return { kind: 'suggestion', remove, outcome };
    }
  }
  // 不可达：全部解锁（k = 锁定数）已判定可行
  throw new Error('修复建议异常：全部解锁可行但未找到可撤销子集');
}
