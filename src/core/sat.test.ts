import { describe, expect, it } from 'vitest';
import type {
  Edge,
  ImplicationStep,
  Rule,
  ShutterState,
  Workspace,
} from './types';
import { computeChanges, solveWorkspace } from './sat';
import { compareUtf8 } from './utf8';

/* ---------------- 独立暴力枚举 oracle（不使用蕴含图） ---------------- */

interface CNF {
  ids: string[];
  clauses: Array<[{ id: string; state: ShutterState }, { id: string; state: ShutterState }]>;
  locks: Record<string, ShutterState>;
}

function evalLit(
  lit: { id: string; state: ShutterState },
  a: Record<string, ShutterState>,
): boolean {
  return a[lit.id] === lit.state;
}

function satisfies(
  cnf: CNF,
  a: Record<string, ShutterState>,
): boolean {
  for (const [id, s] of Object.entries(cnf.locks)) {
    if (a[id] !== s) return false;
  }
  for (const [p, q] of cnf.clauses) {
    if (!evalLit(p, a) && !evalLit(q, a)) return false;
  }
  return true
}

/** 按「ID 的 UTF-8 字节序、CLOSED(0) 优先」枚举，返回第一个满足的赋值；无解为 null。 */
function bruteForceLexMin(cnf: CNF): Record<string, ShutterState> | null {
  const ids = [...cnf.ids].sort(compareUtf8);
  const n = ids.length;
  const total = 1 << n;
  // bit=0 表示 CLOSED（优先），bit=1 表示 OPEN；
  // 首个（字节序最小的）ID 对应最高位，0..total-1 即 CLOSED 优先字典序
  for (let mask = 0; mask < total; mask++) {
    const a: Record<string, ShutterState> = {};
    for (let i = 0; i < n; i++) {
      a[ids[i]] = ((mask >> (n - 1 - i)) & 1) === 0 ? 'CLOSED' : 'OPEN';
    }
    if (satisfies(cnf, a)) return a;
  }
  return null;
}

function bruteForceSat(cnf: CNF): boolean {
  return bruteForceLexMin(cnf) !== null;
}

/**
 * 独立判定矛盾快门：直接在文字蕴含图上用 Warshall 算可达，
 * 某快门 OPEN 与 CLOSED 互相可达即同 SCC。锁定以单位边 ¬l→l 计入，
 * 与求解器的 Tarjan 实现相互独立，可交叉验证。
 */
function bruteForceContradictory(cnf: CNF): Set<string> {
  const ids = [...cnf.ids].sort(compareUtf8);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const n2 = ids.length * 2;
  const node = (id: string, s: ShutterState) =>
    2 * idx.get(id)! + (s === 'CLOSED' ? 1 : 0);
  const reach: Uint8Array[] = Array.from({ length: n2 }, () => new Uint8Array(n2));
  for (let k = 0; k < n2; k++) reach[k][k] = 1;
  for (const [p, q] of cnf.clauses) {
    const np = node(p.id, p.state);
    const nq = node(q.id, q.state);
    reach[np ^ 1][nq] = 1;
    reach[nq ^ 1][np] = 1;
  }
  for (const [id, s] of Object.entries(cnf.locks)) {
    const v = node(id, s);
    reach[v ^ 1][v] = 1;
  }
  for (let k = 0; k < n2; k++) {
    for (let i = 0; i < n2; i++) {
      if (!reach[i][k]) continue;
      for (let j = 0; j < n2; j++) {
        if (reach[k][j]) reach[i][j] = 1;
      }
    }
  }
  const bad = new Set<string>();
  for (const id of ids) {
    const o = node(id, 'OPEN');
    const c = node(id, 'CLOSED');
    if (reach[o][c] && reach[c][o]) bad.add(id);
  }
  return bad;
}

/* ---------------- 测试夹具构造 ---------------- */

function makeRules(
  _ids: string[],
  tuples: Array<[string, ShutterState, string, ShutterState]>,
): Rule[] {
  return tuples.map(([aid, as, bid, bs], index) => ({
    index,
    a: { id: aid, state: as },
    b: { id: bid, state: bs },
    text: `${aid} ${as} OR ${bid} ${bs}`,
  }));
}

function edgesOf(ws: Workspace, locks: Record<string, ShutterState>): Edge[] {
  // 复用与 sat.ts 相同的构图规则，仅用于逐边校验见证
  const sorted = [...ws.ids].sort(compareUtf8);
  const idx = new Map(sorted.map((id, i) => [id, i]));
  const node = (id: string, s: ShutterState) =>
    2 * idx.get(id)! + (s === 'CLOSED' ? 1 : 0);
  const edges: Edge[] = [];
  for (const r of ws.rules) {
    const na = node(r.a.id, r.a.state);
    const nb = node(r.b.id, r.b.state);
    edges.push({ from: na ^ 1, to: nb, reason: { kind: 'rule', ruleIndex: r.index } });
    edges.push({ from: nb ^ 1, to: na, reason: { kind: 'rule', ruleIndex: r.index } });
  }
  for (const [id, s] of Object.entries(locks)) {
    const v = node(id, s);
    edges.push({ from: v ^ 1, to: v, reason: { kind: 'lock', id, state: s } });
  }
  return edges;
}

/** 校验见证路径：端点正确、每一步是真实蕴含边、rule 依据与原规则一致。 */
function expectValidPath(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  startId: string,
  startState: ShutterState,
  steps: ImplicationStep[],
  endState: ShutterState,
) {
  const edgeSet = new Set(
    edgesOf(ws, locks).map((e) => `${e.from}->${e.to}`),
  );
  const nodeLit = (id: string, s: ShutterState) => {
    const sorted = [...ws.ids].sort(compareUtf8);
    return 2 * sorted.indexOf(id) + (s === 'CLOSED' ? 1 : 0);
  };
  if (steps.length === 0) {
    expect(startState).toBe(endState);
    return;
  }
  expect(steps[0].from).toEqual({ id: startId, state: startState });
  const last = steps[steps.length - 1];
  expect(last.to).toEqual({ id: startId, state: endState });
  for (const step of steps) {
    const key = `${nodeLit(step.from.id, step.from.state)}->${nodeLit(
      step.to.id,
      step.to.state,
    )}`;
    expect(edgeSet.has(key), `见证边 ${key} 必须真实存在于蕴含图`).toBe(true);
    // 链式相接
    const cur = steps.indexOf(step);
    if (cur > 0) {
      expect(step.from).toEqual(steps[cur - 1].to);
    }
    if (step.reason.kind === 'rule') {
      const r = ws.rules[step.reason.ruleIndex];
      // 该步必须确为该规则的两条蕴含之一
      const isFirst =
        r.a.id === step.from.id && flip(r.a.state) === step.from.state &&
        r.b.id === step.to.id && r.b.state === step.to.state;
      const isSecond =
        r.b.id === step.from.id && flip(r.b.state) === step.from.state &&
        r.a.id === step.to.id && r.a.state === step.to.state;
      expect(isFirst || isSecond, '每一步都必须指回真正蕴含它的原规则').toBe(true);
    }
  }
}

function flip(s: ShutterState): ShutterState {
  return s === 'OPEN' ? 'CLOSED' : 'OPEN';
}

/* ---------------- 穷举测试 ---------------- */

const STATES: ShutterState[] = ['OPEN', 'CLOSED'];

describe('2-SAT 求解器：3 快门所有规则子集穷举', () => {
  const ids = ['A', 'B', 'C'];
  // 所有合法的二元文字组合（不同快门对，不允许同快门），共 12 条候选
  const candidateDefs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const si of STATES) for (const sj of STATES) {
        candidateDefs.push([ids[i], si, ids[j], sj]);
      }
    }
  }
  expect(candidateDefs).toHaveLength(12);

  const lockOptions: Array<Record<string, ShutterState>> = [
    {},
    { A: 'OPEN' },
    { A: 'CLOSED' },
    { B: 'CLOSED' },
    { A: 'OPEN', C: 'CLOSED' },
  ];

  // 用固定步长抽样规则子集，避免 4096*5 全量过大但仍覆盖从小到饱和的规模
  const masks: number[] = [];
  for (let m = 0; m < 1 << candidateDefs.length; m += 7) masks.push(m);
  masks.push((1 << candidateDefs.length) - 1);

  it.each(masks)('规则子集掩码 %#', (mask) => {
    const defs = candidateDefs.filter((_, k) => (mask >> k) & 1);
    for (const locks of lockOptions) {
      const ws: Workspace = { ids: [...ids], rules: makeRules(ids, defs) };
      const cnf: CNF = {
        ids,
        clauses: defs.map(([a, as, b, bs]) => [{ id: a, state: as }, { id: b, state: bs }]),
        locks,
      };
      const outcome = solveWorkspace(ws, locks);
      if (bruteForceSat(cnf)) {
        const expect1 = bruteForceLexMin(cnf)!;
        expect(outcome.kind).toBe('sat');
        if (outcome.kind === 'sat') {
          for (const id of ids) expect(outcome.assignment[id]).toBe(expect1[id]);
          // 完整性
          expect(Object.keys(outcome.assignment).sort()).toEqual([...ids].sort());
        }
      } else {
        expect(outcome.kind).toBe('unsat');
        if (outcome.kind === 'unsat') {
          const bad = bruteForceContradictory(cnf);
          expect(bad.size).toBeGreaterThan(0);
          // 必须选 UTF-8 字节序最小的矛盾快门
          let minId = [...bad][0];
          for (const id of bad) if (compareUtf8(id, minId) < 0) minId = id;
          expect(outcome.witness.id).toBe(minId);
          expect(bad.has(outcome.witness.id)).toBe(true);
          // 两条见证路径都合法
          expectValidPath(
            ws,
            locks,
            outcome.witness.id,
            'OPEN',
            outcome.witness.openToClosed,
            'CLOSED',
          );
          expectValidPath(
            ws,
            locks,
            outcome.witness.id,
            'CLOSED',
            outcome.witness.closedToOpen,
            'OPEN',
          );
        }
      }
    }
  });
});

describe('2-SAT 求解器：n=2 全部 16 种规则子集 + 全锁定组合', () => {
  const ids = ['A', 'B'];
  const defs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (const sa of STATES) for (const sb of STATES) defs.push(['A', sa, 'B', sb]);

  const cases: Array<{
    mask: number;
    chosen: typeof defs;
    locks: Record<string, ShutterState>;
  }> = [];
  for (let mask = 0; mask < 1 << defs.length; mask++) {
    const chosen = defs.filter((_, k) => (mask >> k) & 1);
    const lockCases: Array<Record<string, ShutterState>> = [{}];
    for (const sa of STATES) {
      lockCases.push({ A: sa });
      for (const sb of STATES) lockCases.push({ A: sa, B: sb });
    }
    for (const locks of lockCases) cases.push({ mask, chosen, locks });
  }

  it.each(cases)('规则子集 $mask + 锁定 $locks', ({ chosen, locks }) => {
    const ws: Workspace = { ids: [...ids], rules: makeRules(ids, chosen) };
    const cnf: CNF = {
      ids,
      clauses: chosen.map(([a, sa, b, sb]) => [{ id: a, state: sa }, { id: b, state: sb }]),
      locks,
    };
    const got = solveWorkspace(ws, locks);
    const want = bruteForceLexMin(cnf);
    if (want === null) {
      expect(got.kind).toBe('unsat');
    } else if (got.kind === 'sat') {
      expect(got.assignment).toEqual(want);
    } else {
      throw new Error('oracle 认为可满足，求解器却判无解');
    }
  });
});

describe('多字节 ID 的字节序最小性', () => {
  it('CLOSED 优先方案按 UTF-8 字节序选取', () => {
    // 无规则：任何赋值都行，最小方案必须全部 CLOSED
    const ws: Workspace = { ids: ['中', 'A', 'z'], rules: [] };
    const r = solveWorkspace(ws, {});
    expect(r.kind).toBe('sat');
    if (r.kind === 'sat') {
      expect(r.orderedIds).toEqual(['A', 'z', '中']);
      for (const id of ws.ids) expect(r.assignment[id]).toBe('CLOSED');
    }
  });

  it('无规则 + 锁定某快门 OPEN 时其余仍 CLOSED 优先', () => {
    const ws: Workspace = { ids: ['S2', 'S1', 'S10'], rules: [] };
    const r = solveWorkspace(ws, { S10: 'OPEN' });
    expect(r.kind).toBe('sat');
    if (r.kind === 'sat') {
      expect(r.assignment).toEqual({
        S1: 'CLOSED',
        S10: 'OPEN',
        S2: 'CLOSED',
      });
    }
  });
});

describe('改动列表与锁定失效', () => {

  const ws: Workspace = {
    ids: ['A', 'B'],
    rules: makeRules(['A', 'B'], [['A', 'OPEN', 'B', 'OPEN']]),
  };

  it('列出从当前表到最小方案的改动（按字节序）', () => {
    // 最小方案：A=CLOSED,B=OPEN（A CLOSED 可行时 B 须 OPEN）
    const r = solveWorkspace(ws, {});
    expect(r.kind).toBe('sat');
    if (r.kind !== 'sat') return;
    const current: Record<string, ShutterState> = { A: 'OPEN', B: 'CLOSED' };
    const changes = computeChanges(r.orderedIds, r.assignment, current);
    expect(changes).toEqual([
      { id: 'A', from: 'OPEN', to: 'CLOSED' },
      { id: 'B', from: 'CLOSED', to: 'OPEN' },
    ]);
  });

  it('锁定导致无解时给出最小矛盾 ID 与闭环', () => {
    // 规则 A_OPEN∨B_OPEN；锁 A=CLOSED 且 B=CLOSED → 冲突
    const r = solveWorkspace(ws, { A: 'CLOSED', B: 'CLOSED' });
    expect(r.kind).toBe('unsat');
    if (r.kind !== 'unsat') return;
    expect(['A', 'B']).toContain(r.witness.id);
    expect(r.witness.openToClosed.length).toBeGreaterThan(0);
    expect(r.witness.closedToOpen.length).toBeGreaterThan(0);
  });
});

/** 确定性的简单 LCG，保证随机用例可复现。 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('随机交叉验证（n=8，独立暴力枚举）', () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const rng = makeRng(20260923);

  for (let t = 0; t < 120; t++) {
    it(`随机实例 #${t}`, () => {
      const defs: Array<[string, ShutterState, string, ShutterState]> = [];
      const ruleCount = 1 + Math.floor(rng() * 12);
      for (let k = 0; k < ruleCount; k++) {
        let i = Math.floor(rng() * ids.length);
        let j = Math.floor(rng() * ids.length);
        while (j === i) j = Math.floor(rng() * ids.length);
        const si = STATES[Math.floor(rng() * 2)];
        const sj = STATES[Math.floor(rng() * 2)];
        defs.push([ids[i], si, ids[j], sj]);
      }
      const locks: Record<string, ShutterState> = {};
      const lockCount = Math.floor(rng() * 3);
      for (let k = 0; k < lockCount; k++) {
        locks[ids[Math.floor(rng() * ids.length)]] =
          STATES[Math.floor(rng() * 2)];
      }
      const ws: Workspace = { ids: [...ids], rules: makeRules(ids, defs) };
      const cnf: CNF = {
        ids,
        clauses: defs.map(([a, sa, b, sb]) => [{ id: a, state: sa }, { id: b, state: sb }]),
        locks,
      };
      const outcome = solveWorkspace(ws, locks);
      const want = bruteForceLexMin(cnf);
      if (want === null) {
        expect(outcome.kind).toBe('unsat');
        if (outcome.kind === 'unsat') {
          const bad = bruteForceContradictory(cnf);
          let minId = [...bad][0];
          for (const id of bad) if (compareUtf8(id, minId) < 0) minId = id;
          expect(outcome.witness.id).toBe(minId);
          expectValidPath(
            ws,
            locks,
            outcome.witness.id,
            'OPEN',
            outcome.witness.openToClosed,
            'CLOSED',
          );
          expectValidPath(
            ws,
            locks,
            outcome.witness.id,
            'CLOSED',
            outcome.witness.closedToOpen,
            'OPEN',
          );
        }
      } else {
        expect(outcome.kind).toBe('sat');
        if (outcome.kind === 'sat') expect(outcome.assignment).toEqual(want);
      }
    });
  }
});

describe('规模与性能（300 快门 / 3000 规则）', () => {
  it('上限规模下单次认证在合理时间内完成且结果完整', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `SH-${String(i).padStart(3, '0')}`);
    const defs: Array<[string, ShutterState, string, ShutterState]> = [];
    for (let k = 0; k < 3000; k++) {
      const i = k % 299;
      const j = (i + 1 + ((k / 299) | 0)) % 300;
      // 每条子句都含 CLOSED 文字，保证“全 CLOSED”是可行方案
      defs.push([
        ids[i],
        STATES[k & 1],
        ids[j],
        'CLOSED',
      ]);
    }
    const ws: Workspace = { ids, rules: makeRules(ids, defs) };
    const started = Date.now();
    const r = solveWorkspace(ws, {});
    const elapsed = Date.now() - started;
    // 300 次 O(V+E) 重算，留足裕量
    expect(elapsed).toBeLessThan(15000);
    expect(r.kind).toBe('sat');
    if (r.kind === 'sat') {
      expect(r.orderedIds).toHaveLength(300);
      expect(Object.keys(r.assignment)).toHaveLength(300);
      // 每条规则必须被方案满足
      for (const rule of ws.rules) {
        const ok =
          r.assignment[rule.a.id] === rule.a.state ||
          r.assignment[rule.b.id] === rule.b.state;
        expect(ok, `规则 #${rule.index} 必须被返回方案满足`).toBe(true);
      }
    }
  });
});

/* ------------- 特殊快门 ID：__proto__ / constructor / toString / OR ------------- */

/**
 * 与文件顶部暴力枚举 oracle 相同的语义，但用 Map 承载赋值，
 * 使 __proto__ 等 ID 也能正确求值（普通对象会被 __proto__ 访问器吞掉）。
 */
function bruteLexMinSafe(
  ids: string[],
  clauses: Array<[{ id: string; state: ShutterState }, { id: string; state: ShutterState }]>,
  locks: Record<string, ShutterState>,
): Record<string, ShutterState> | null {
  const sorted = [...ids].sort(compareUtf8);
  const n = sorted.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const a = new Map<string, ShutterState>();
    for (let i = 0; i < n; i++) {
      a.set(sorted[i], ((mask >> (n - 1 - i)) & 1) === 0 ? 'CLOSED' : 'OPEN');
    }
    let ok = true;
    for (const [id, s] of Object.entries(locks)) {
      if (a.get(id) !== s) {
        ok = false;
        break;
      }
    }
    if (ok) {
      for (const [p, q] of clauses) {
        if (a.get(p.id) !== p.state && a.get(q.id) !== q.state) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return Object.fromEntries(a);
  }
  return null;
}

describe('特殊快门 ID（__proto__ / constructor / toString / OR）', () => {
  const specialIds = ['OR', '__proto__', 'constructor', 'toString'];

  it('最小方案完整：每个特殊 ID 都是独立自有条目', () => {
    const ws: Workspace = { ids: [...specialIds], rules: [] };
    const r = solveWorkspace(ws, {});
    expect(r.kind).toBe('sat');
    if (r.kind !== 'sat') return;
    // UTF-8 字节序：OR(0x4F…) < __proto__(0x5F…) < constructor(0x63…) < toString(0x74…)
    expect(r.orderedIds).toEqual(['OR', '__proto__', 'constructor', 'toString']);
    expect(Object.keys(r.assignment)).toHaveLength(specialIds.length);
    for (const id of specialIds) {
      expect(Object.prototype.hasOwnProperty.call(r.assignment, id)).toBe(true);
      expect(r.assignment[id]).toBe('CLOSED');
    }
  });

  it('锁定 __proto__ / toString 被求解器遵守，其余仍 CLOSED 优先', () => {
    const ws: Workspace = { ids: [...specialIds], rules: [] };
    // 注意：__proto__ 必须落为自有属性（fromEntries / 计算属性键），
    // 普通赋值或字面量 __proto__: 键会被原型访问器吞掉
    const locks: Record<string, ShutterState> = Object.fromEntries(
      [
        ['__proto__', 'OPEN'],
        ['toString', 'OPEN'],
      ] as Array<[string, ShutterState]>,
    );
    const r = solveWorkspace(ws, locks);
    expect(r.kind).toBe('sat');
    if (r.kind !== 'sat') return;
    expect(Object.keys(r.assignment)).toHaveLength(specialIds.length);
    expect(r.assignment['__proto__']).toBe('OPEN');
    expect(r.assignment['toString']).toBe('OPEN');
    expect(r.assignment['OR']).toBe('CLOSED');
    expect(r.assignment['constructor']).toBe('CLOSED');
  });

  it('特殊 ID 参与规则与锁定冲突：见证与闭环逐边合法', () => {
    // __proto__ OPEN ∨ OR OPEN；两者均锁 CLOSED → 均矛盾，见证取字节序最小者 OR
    const ws: Workspace = {
      ids: ['__proto__', 'OR'],
      rules: makeRules(['__proto__', 'OR'], [['__proto__', 'OPEN', 'OR', 'OPEN']]),
    };
    const locks: Record<string, ShutterState> = Object.fromEntries(
      [
        ['__proto__', 'CLOSED'],
        ['OR', 'CLOSED'],
      ] as Array<[string, ShutterState]>,
    );
    const r = solveWorkspace(ws, locks);
    expect(r.kind).toBe('unsat');
    if (r.kind !== 'unsat') return;
    expect(r.witness.id).toBe('OR');
    expectValidPath(ws, locks, 'OR', 'OPEN', r.witness.openToClosed, 'CLOSED');
    expectValidPath(ws, locks, 'OR', 'CLOSED', r.witness.closedToOpen, 'OPEN');
  });

  it('改动列表覆盖特殊 ID（按 UTF-8 字节序）', () => {
    // __proto__ OPEN ∨ OR OPEN：最小方案为 OR=CLOSED、__proto__=OPEN
    const ws: Workspace = {
      ids: ['__proto__', 'OR'],
      rules: makeRules(['__proto__', 'OR'], [['__proto__', 'OPEN', 'OR', 'OPEN']]),
    };
    const r = solveWorkspace(ws, {});
    expect(r.kind).toBe('sat');
    if (r.kind !== 'sat') return;
    expect(r.assignment['OR']).toBe('CLOSED');
    expect(r.assignment['__proto__']).toBe('OPEN');
    const current: Record<string, ShutterState> = Object.fromEntries(
      [
        ['__proto__', 'CLOSED'],
        ['OR', 'OPEN'],
      ] as Array<[string, ShutterState]>,
    );
    const changes = computeChanges(r.orderedIds, r.assignment, current);
    expect(changes).toEqual([
      { id: 'OR', from: 'OPEN', to: 'CLOSED' },
      { id: '__proto__', from: 'CLOSED', to: 'OPEN' },
    ]);
  });
});

describe('特殊 ID 穷举交叉验证（__proto__ 与 OR，独立暴力枚举）', () => {
  const ids = ['__proto__', 'OR'];
  const defs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (const sa of STATES) for (const sb of STATES) {
    defs.push(['__proto__', sa, 'OR', sb]);
  }

  const lockCases: Array<Record<string, ShutterState>> = [{}];
  for (const sa of STATES) {
    lockCases.push({ ['__proto__']: sa });
    for (const sb of STATES) lockCases.push({ ['__proto__']: sa, OR: sb });
  }

  const cases: Array<{
    mask: number;
    chosen: typeof defs;
    locks: Record<string, ShutterState>;
  }> = [];
  for (let mask = 0; mask < 1 << defs.length; mask++) {
    const chosen = defs.filter((_, k) => (mask >> k) & 1);
    for (const locks of lockCases) cases.push({ mask, chosen, locks });
  }

  it.each(cases)('规则子集 $mask + 锁定 $locks', ({ chosen, locks }) => {
    const ws: Workspace = { ids: [...ids], rules: makeRules(ids, chosen) };
    const got = solveWorkspace(ws, locks);
    const want = bruteLexMinSafe(
      ids,
      chosen.map(([a, sa, b, sb]) => [{ id: a, state: sa }, { id: b, state: sb }]),
      locks,
    );
    if (want === null) {
      expect(got.kind).toBe('unsat');
    } else {
      expect(got.kind).toBe('sat');
      if (got.kind === 'sat') {
        // 方案完整且每个特殊 ID 都是自有条目
        expect(Object.keys(got.assignment).sort()).toEqual([...ids].sort());
        for (const id of ids) {
          expect(Object.prototype.hasOwnProperty.call(got.assignment, id)).toBe(true);
          expect(got.assignment[id]).toBe(want[id]);
        }
      }
    }
  });
});
