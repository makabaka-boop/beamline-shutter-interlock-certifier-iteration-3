import { describe, expect, it } from 'vitest';
import type { Rule, ShutterState, Workspace } from './types';
import { MAX_REPAIR_LOCKS, suggestLockRepair } from './repair';
import { solveWorkspace } from './sat';
import { compareUtf8 } from './utf8';

/* ---------- 独立暴力 oracle：不经过蕴含图 / Tarjan，直接枚举全部赋值 ---------- */

function assignmentSatisfies(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  a: Map<string, ShutterState>,
): boolean {
  for (const [id, s] of Object.entries(locks)) {
    if (a.get(id) !== s) return false;
  }
  for (const r of ws.rules) {
    if (a.get(r.a.id) !== r.a.state && a.get(r.b.id) !== r.b.state) return false;
  }
  return true;
}

/** 枚举全部 2^n 赋值：bit=0 为 CLOSED，字节序最小 ID 占最高位 → CLOSED 优先字典序。 */
function* enumerateAssignments(ids: string[]): Generator<Map<string, ShutterState>> {
  const sorted = [...ids].sort(compareUtf8);
  const n = sorted.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const a = new Map<string, ShutterState>();
    for (let i = 0; i < n; i++) {
      a.set(sorted[i], ((mask >> (n - 1 - i)) & 1) === 0 ? 'CLOSED' : 'OPEN');
    }
    yield a;
  }
}

function bruteSat(ws: Workspace, locks: Record<string, ShutterState>): boolean {
  for (const a of enumerateAssignments(ws.ids)) {
    if (assignmentSatisfies(ws, locks, a)) return true;
  }
  return false;
}

function bruteLexMin(
  ws: Workspace,
  locks: Record<string, ShutterState>,
): Record<string, ShutterState> | null {
  for (const a of enumerateAssignments(ws.ids)) {
    if (assignmentSatisfies(ws, locks, a)) return Object.fromEntries(a);
  }
  return null;
}

/** 逐元素比较两个已按 UTF-8 字节序排序的 ID 清单。 */
function compareIdLists(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareUtf8(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/**
 * 修复 oracle：枚举全部锁定子集（不止最少规模），独立求出
 * 「精确最少撤销数 + 并列时排序清单字典序最小」的撤销清单。
 */
function repairOracle(
  ws: Workspace,
  locks: Record<string, ShutterState>,
): { remove: string[] } | 'rules-conflict' {
  if (!bruteSat(ws, {})) return 'rules-conflict';
  const lockedIds = Object.keys(locks).sort(compareUtf8);
  let best: string[] | null = null;
  for (let mask = 0; mask < 1 << lockedIds.length; mask++) {
    const subset = lockedIds.filter((_, i) => ((mask >> i) & 1) === 1);
    if (best && subset.length > best.length) continue;
    const remaining = Object.fromEntries(
      Object.entries(locks).filter(([id]) => !subset.includes(id)),
    );
    if (!bruteSat(ws, remaining)) continue;
    if (
      !best ||
      subset.length < best.length ||
      (subset.length === best.length && compareIdLists(subset, best) < 0)
    ) {
      best = subset;
    }
  }
  return { remove: best! };
}

/* ---------------- 夹具与共享断言 ---------------- */

function makeRules(
  tuples: Array<[string, ShutterState, string, ShutterState]>,
): Rule[] {
  return tuples.map(([aid, as, bid, bs], index) => ({
    index,
    a: { id: aid, state: as },
    b: { id: bid, state: bs },
    text: `${aid} ${as} OR ${bid} ${bs}`,
  }));
}

function removeKeys(
  locks: Record<string, ShutterState>,
  remove: string[],
): Record<string, ShutterState> {
  const drop = new Set(remove);
  return Object.fromEntries(Object.entries(locks).filter(([id]) => !drop.has(id)));
}

/** 建议必须与独立 oracle 完全一致，且方案来自原求解器、不翻转保留的锁定。 */
function expectRepairMatchesOracle(
  ws: Workspace,
  locks: Record<string, ShutterState>,
) {
  const repair = suggestLockRepair(ws, locks);
  const oracle = repairOracle(ws, locks);
  if (oracle === 'rules-conflict') {
    expect(repair.kind).toBe('rules-conflict');
    return;
  }
  expect(repair.kind).toBe('suggestion');
  if (repair.kind !== 'suggestion') return;

  // 最小性与并列裁决：撤销清单与独立 oracle 逐项一致
  expect(repair.remove).toEqual(oracle.remove);
  // 清单只含当前已锁定的 ID，且按 UTF-8 字节序排列
  for (const id of repair.remove) {
    expect(Object.prototype.hasOwnProperty.call(locks, id)).toBe(true);
  }
  expect([...repair.remove].sort(compareUtf8)).toEqual(repair.remove);

  // 撤销后的方案 = 原 2-SAT 求解器在剩余锁定下的结果
  const remaining = removeKeys(locks, repair.remove);
  const resolved = solveWorkspace(ws, remaining);
  expect(resolved.kind).toBe('sat');
  if (resolved.kind !== 'sat') return;
  expect(repair.outcome.assignment).toEqual(resolved.assignment);
  expect(repair.outcome.orderedIds).toEqual(resolved.orderedIds);

  // 且与独立暴力枚举的 CLOSED 优先字典序最小解一致（完整方案）
  const want = bruteLexMin(ws, remaining)!;
  expect(Object.keys(repair.outcome.assignment).sort()).toEqual([...ws.ids].sort());
  for (const id of ws.ids) {
    expect(repair.outcome.assignment[id]).toBe(want[id]);
  }
  // 保留的锁定一律不被翻转：方案必须遵守每一把未撤销的锁
  for (const [id, s] of Object.entries(remaining)) {
    expect(repair.outcome.assignment[id]).toBe(s);
  }
}

/* ---------------- 穷举：小规模锁定子集核对最小性与并列裁决 ---------------- */

describe('锁定修复建议：3 快门规则子集 × 全部锁定组合穷举', () => {
  const ids = ['A', 'B', 'C'];
  const STATES: ShutterState[] = ['OPEN', 'CLOSED'];
  const candidateDefs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const si of STATES) {
        for (const sj of STATES) candidateDefs.push([ids[i], si, ids[j], sj]);
      }
    }
  }
  expect(candidateDefs).toHaveLength(12);

  // 每个快门：不锁 / 锁 OPEN / 锁 CLOSED → 27 种锁定组合（0–3 把锁）
  const lockCombos: Array<Record<string, ShutterState>> = [];
  for (const a of [null, ...STATES] as const) {
    for (const b of [null, ...STATES] as const) {
      for (const c of [null, ...STATES] as const) {
        const locks: Record<string, ShutterState> = {};
        if (a) locks.A = a;
        if (b) locks.B = b;
        if (c) locks.C = c;
        lockCombos.push(locks);
      }
    }
  }
  expect(lockCombos).toHaveLength(27);

  const masks: number[] = [];
  for (let m = 0; m < 1 << candidateDefs.length; m += 7) masks.push(m);
  masks.push((1 << candidateDefs.length) - 1);

  it.each(masks)('规则子集掩码 %#', (mask) => {
    const defs = candidateDefs.filter((_, k) => (mask >> k) & 1);
    const ws: Workspace = { ids: [...ids], rules: makeRules(defs) };
    for (const locks of lockCombos) {
      expectRepairMatchesOracle(ws, locks);
    }
  });
});

/* ---------------- 并列裁决的定向用例 ---------------- */

describe('锁定修复建议：并列裁决定向用例', () => {
  it('并列最少撤销取 UTF-8 字节序最小者', () => {
    // A OPEN ∨ B OPEN，A、B 均锁 CLOSED：撤 A 或撤 B 都可解 → 选 A
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const repair = suggestLockRepair(ws, { A: 'CLOSED', B: 'CLOSED' });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual(['A']);
    expect(repair.outcome.assignment).toEqual({ A: 'OPEN', B: 'CLOSED' });
  });

  it('并列裁决按 UTF-8 字节序（多字节 ID）', () => {
    // Z(0x5A) 与 中(0xE4…) 均锁 CLOSED，规则要求至少一个 OPEN：撤任一即可 → 选 Z
    const ws: Workspace = {
      ids: ['中', 'Z'],
      rules: makeRules([['Z', 'OPEN', '中', 'OPEN']]),
    };
    const repair = suggestLockRepair(ws, { Z: 'CLOSED', 中: 'CLOSED' });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual(['Z']);
    expect(repair.outcome.assignment).toEqual({ Z: 'OPEN', 中: 'CLOSED' });
  });

  it('并列裁决严格按 UTF-8 字节序，而非 UTF-16 码元序', () => {
    // U+E000：UTF-8 首字节 0xEE；U+10000：UTF-8 首字节 0xF0，UTF-16 为代理对（首码元 0xD800）。
    // UTF-16 码元序下 U+10000 更小，UTF-8 字节序下 U+E000 更小。
    const bmp = '\uE000'; // U+E000（UTF-8：EE 80 80）
    const astral = '𐀀';
    expect(bmp < astral).toBe(false); // JS 默认字符串序（UTF-16）下 astral 更小
    expect(compareUtf8(bmp, astral)).toBeLessThan(0);
    const ws: Workspace = {
      ids: [astral, bmp],
      rules: makeRules([[bmp, 'OPEN', astral, 'OPEN']]),
    };
    const repair = suggestLockRepair(ws, { [bmp]: 'CLOSED', [astral]: 'CLOSED' });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual([bmp]);
  });

  it('最少撤销数为 2 且多组并列：逐元素比较排序后的清单', () => {
    // 两对独立冲突：(A OPEN ∨ B OPEN) 与 (C OPEN ∨ D OPEN)，四者均锁 CLOSED。
    // 最少撤 2 个；可行清单 {A,C} {A,D} {B,C} {B,D} → 字典序最小为 [A, C]
    const ws: Workspace = {
      ids: ['A', 'B', 'C', 'D'],
      rules: makeRules([
        ['A', 'OPEN', 'B', 'OPEN'],
        ['C', 'OPEN', 'D', 'OPEN'],
      ]),
    };
    const repair = suggestLockRepair(ws, {
      A: 'CLOSED',
      B: 'CLOSED',
      C: 'CLOSED',
      D: 'CLOSED',
    });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual(['A', 'C']);
    expect(repair.outcome.assignment).toEqual({
      A: 'OPEN',
      B: 'CLOSED',
      C: 'OPEN',
      D: 'CLOSED',
    });
  });

  it('只撤销锁定，绝不通过翻转锁定值来“修复”', () => {
    // 两条规则合起来迫使 B=OPEN；锁 B=CLOSED 造成无解。
    // 把锁定值翻成 OPEN 也能满足规则，但那不是合法修复——必须撤销该锁。
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([
        ['A', 'OPEN', 'B', 'OPEN'],
        ['A', 'CLOSED', 'B', 'OPEN'],
      ]),
    };
    const repair = suggestLockRepair(ws, { B: 'CLOSED' });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual(['B']);
    expect(repair.outcome.assignment).toEqual({ A: 'CLOSED', B: 'OPEN' });
  });

  it('修复计算不改动规则与锁定输入', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const locks: Record<string, ShutterState> = { A: 'CLOSED', B: 'CLOSED' };
    const rulesJson = JSON.stringify(ws.rules);
    suggestLockRepair(ws, locks);
    expect(JSON.stringify(ws.rules)).toBe(rulesJson);
    expect(locks).toEqual({ A: 'CLOSED', B: 'CLOSED' });
  });

  it('当前锁定本就可行时最少撤销为空清单（界面不会在可行时调用，函数保持总量）', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const repair = suggestLockRepair(ws, { A: 'OPEN' });
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    expect(repair.remove).toEqual([]);
    expect(repair.outcome.assignment).toEqual({ A: 'OPEN', B: 'CLOSED' });
  });
});

/* ---------------- 规则自身冲突与锁定数量上限 ---------------- */

describe('锁定修复建议：规则自身冲突与锁定上限', () => {
  // 经典 2-SAT 不可满足核：四个子句覆盖 A、B 的全部组合
  const unsatCoreRules = makeRules([
    ['A', 'OPEN', 'B', 'OPEN'],
    ['A', 'OPEN', 'B', 'CLOSED'],
    ['A', 'CLOSED', 'B', 'OPEN'],
    ['A', 'CLOSED', 'B', 'CLOSED'],
  ]);

  it('全部解锁仍无解 → 明确报告规则自身冲突，不提供建议', () => {
    const ws: Workspace = { ids: ['A', 'B'], rules: unsatCoreRules };
    expect(suggestLockRepair(ws, {})).toEqual({ kind: 'rules-conflict' });
    expect(suggestLockRepair(ws, { A: 'OPEN' })).toEqual({
      kind: 'rules-conflict',
    });
  });

  it('规则冲突优先于锁定数量报告（锁定再多也不给假建议）', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const ws: Workspace = { ids, rules: unsatCoreRules };
    const locks = Object.fromEntries(
      ids.map((id): [string, ShutterState] => [id, 'CLOSED']),
    );
    expect(Object.keys(locks)).toHaveLength(9);
    expect(suggestLockRepair(ws, locks)).toEqual({ kind: 'rules-conflict' });
  });

  it('锁定数超过 8 且规则本身可行 → 报告锁定过多，不求精确解', () => {
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    // 规则本身可行（全 CLOSED 即满足），但 9 个 OPEN 锁定与之冲突
    const ws: Workspace = {
      ids,
      rules: makeRules([['A', 'CLOSED', 'B', 'CLOSED']]),
    };
    const locks = Object.fromEntries(
      ids.map((id): [string, ShutterState] => [id, 'OPEN']),
    );
    expect(suggestLockRepair(ws, locks)).toEqual({
      kind: 'too-many-locks',
      count: 9,
    });
  });

  it('锁定数恰为上限 8：仍给出精确最少建议，无辜锁定保留不翻转', () => {
    expect(MAX_REPAIR_LOCKS).toBe(8);
    const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const ws: Workspace = {
      ids,
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const locks: Record<string, ShutterState> = {
      A: 'CLOSED',
      B: 'CLOSED',
      C: 'OPEN',
      D: 'CLOSED',
      E: 'OPEN',
      F: 'CLOSED',
      G: 'OPEN',
      H: 'CLOSED',
    };
    const repair = suggestLockRepair(ws, locks);
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    // 撤 A 或撤 B 均可 → 取字节序最小的 A；其余 7 把锁全部保留
    expect(repair.remove).toEqual(['A']);
    const kept: Record<string, ShutterState> = {
      B: 'CLOSED',
      C: 'OPEN',
      D: 'CLOSED',
      E: 'OPEN',
      F: 'CLOSED',
      G: 'OPEN',
      H: 'CLOSED',
    };
    for (const [id, s] of Object.entries(kept)) {
      expect(repair.outcome.assignment[id]).toBe(s);
    }
    expect(repair.outcome.assignment.A).toBe('OPEN');
  });
});

/* ---------------- 特殊快门 ID ---------------- */

describe('锁定修复建议：特殊快门 ID（__proto__ / toString）', () => {
  it('特殊 ID 的锁定可撤销，方案中每个 ID 都是独立自有条目', () => {
    const ws: Workspace = {
      ids: ['__proto__', 'toString'],
      rules: makeRules([['__proto__', 'OPEN', 'toString', 'OPEN']]),
    };
    const locks: Record<string, ShutterState> = Object.fromEntries(
      [
        ['__proto__', 'CLOSED'],
        ['toString', 'CLOSED'],
      ] as Array<[string, ShutterState]>,
    );
    const repair = suggestLockRepair(ws, locks);
    expect(repair.kind).toBe('suggestion');
    if (repair.kind !== 'suggestion') return;
    // UTF-8 字节序：__proto__(0x5F) < toString(0x74)
    expect(repair.remove).toEqual(['__proto__']);
    const a = repair.outcome.assignment;
    expect(Object.keys(a)).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(a, '__proto__')).toBe(true);
    expect(a['__proto__']).toBe('OPEN');
    // 保留的锁定不被翻转
    expect(a['toString']).toBe('CLOSED');
  });
});
