import { describe, expect, it } from 'vitest';
import type {
  Edge,
  ImplicationStep,
  Rule,
  ShutterState,
  Workspace,
} from './types';
import { MAX_RULES, parseCandidateRule } from './parser';
import {
  assignmentRespectsLocks,
  assignmentSatisfiesCandidate,
  assignmentViolatesCandidate,
  precheckCandidate,
  withCandidateRule,
  type CandidateRule,
} from './candidate';
import { solveWorkspace } from './sat';
import { compareUtf8 } from './utf8';

/* ---------------- 独立暴力枚举 oracle（不使用蕴含图） ---------------- */

const flip = (s: ShutterState): ShutterState => (s === 'OPEN' ? 'CLOSED' : 'OPEN');

interface Clause {
  a: { id: string; state: ShutterState };
  b: { id: string; state: ShutterState };
}

/** 按「ID 的 UTF-8 字节序、CLOSED(0) 优先」枚举全部 2^n 个赋值。 */
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

function assignmentOk(
  a: Map<string, ShutterState>,
  clauses: Clause[],
  locks: Record<string, ShutterState>,
  extra?: Clause,
): boolean {
  for (const [id, s] of Object.entries(locks)) {
    if (a.get(id) !== s) return false;
  }
  const check = (c: Clause) =>
    a.get(c.a.id) === c.a.state || a.get(c.b.id) === c.b.state;
  for (const c of clauses) if (!check(c)) return false;
  if (extra && !check(extra)) return false;
  return true;
}

function lexMin(
  ids: string[],
  pred: (a: Map<string, ShutterState>) => boolean,
): Record<string, ShutterState> | null {
  for (const a of enumerateAssignments(ids)) {
    if (pred(a)) return Object.fromEntries(a);
  }
  return null;
}

type OracleKind = 'baseline-conflict' | 'candidate-conflict' | 'redundant' | 'tightening';

function oracleCategorize(
  ids: string[],
  clauses: Clause[],
  locks: Record<string, ShutterState>,
  candidate: Clause,
): OracleKind {
  const baseFeasible = lexMin(ids, (a) => assignmentOk(a, clauses, locks)) !== null;
  if (!baseFeasible) return 'baseline-conflict';
  const candFeasible =
    lexMin(ids, (a) => assignmentOk(a, clauses, locks, candidate)) !== null;
  if (!candFeasible) return 'candidate-conflict';
  const violating =
    lexMin(ids, (a) => {
      if (!assignmentOk(a, clauses, locks)) return false;
      return (
        a.get(candidate.a.id) !== candidate.a.state &&
        a.get(candidate.b.id) !== candidate.b.state
      );
    }) !== null;
  return violating ? 'tightening' : 'redundant';
}

/* ---------------- 夹具与见证校验 ---------------- */

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

function edgesOf(
  ws: Workspace,
  locks: Record<string, ShutterState>,
): Edge[] {
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

/** 校验蕴含路径：端点、链式相接、每步是真实边，rule 依据指回对应规则。 */
function expectValidPath(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  startId: string,
  startState: ShutterState,
  steps: ImplicationStep[],
  endState: ShutterState,
) {
  const edgeSet = new Set(edgesOf(ws, locks).map((e) => `${e.from}->${e.to}`));
  const sorted = [...ws.ids].sort(compareUtf8);
  const nodeLit = (id: string, s: ShutterState) =>
    2 * sorted.indexOf(id) + (s === 'CLOSED' ? 1 : 0);
  if (steps.length === 0) {
    expect(startState).toBe(endState);
    return;
  }
  expect(steps[0].from).toEqual({ id: startId, state: startState });
  expect(steps[steps.length - 1].to).toEqual({ id: startId, state: endState });
  steps.forEach((step, cur) => {
    const key = `${nodeLit(step.from.id, step.from.state)}->${nodeLit(
      step.to.id,
      step.to.state,
    )}`;
    expect(edgeSet.has(key), `见证边 ${key} 必须真实存在于蕴含图`).toBe(true);
    if (cur > 0) expect(step.from).toEqual(steps[cur - 1].to);
    if (step.reason.kind === 'rule') {
      const r = ws.rules[step.reason.ruleIndex];
      const isFirst =
        r.a.id === step.from.id && flip(r.a.state) === step.from.state &&
        r.b.id === step.to.id && r.b.state === step.to.state;
      const isSecond =
        r.b.id === step.from.id && flip(r.b.state) === step.from.state &&
        r.a.id === step.to.id && r.a.state === step.to.state;
      expect(isFirst || isSecond, '每步必须指回真正蕴含它的规则').toBe(true);
    }
  });
}

/** 路径中出现的全部规则序号（用于核对旧冲突不含候选边）。 */
function ruleIndicesOf(steps: ImplicationStep[]): number[] {
  return steps
    .map((s) => (s.reason.kind === 'rule' ? s.reason.ruleIndex : -1))
    .filter((i) => i >= 0);
}

function expectPlanComplete(
  ws: Workspace,
  plan: { orderedIds: string[]; assignment: Record<string, ShutterState> },
  locks: Record<string, ShutterState>,
  expected: Record<string, ShutterState>,
) {
  expect(plan.orderedIds).toEqual([...ws.ids].sort(compareUtf8));
  expect(Object.keys(plan.assignment).sort()).toEqual([...ws.ids].sort());
  for (const id of ws.ids) expect(plan.assignment[id]).toBe(expected[id]);
  expect(assignmentRespectsLocks(plan.assignment, locks)).toBe(true);
  // 每条原规则都被方案满足
  for (const r of ws.rules) {
    const ok =
      plan.assignment[r.a.id] === r.a.state ||
      plan.assignment[r.b.id] === r.b.state;
    expect(ok, `方案必须满足原规则 #${r.index}`).toBe(true);
  }
}

/* ---------------- n=2：全部规则子集 × 全锁定组合 × 全部候选，穷举 ---------------- */

describe('候选规则预检：n=2 全量穷举（16 规则子集 × 9 锁定 × 4 候选）', () => {
  const ids = ['A', 'B'];
  const STATES: ShutterState[] = ['OPEN', 'CLOSED'];
  const defs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (const sa of STATES) for (const sb of STATES) defs.push(['A', sa, 'B', sb]);
  const candidateDefs = defs;

  const lockCombos: Array<Record<string, ShutterState>> = [{}];
  for (const sa of STATES) {
    lockCombos.push({ A: sa });
    lockCombos.push({ B: sa });
    for (const sb of STATES) lockCombos.push({ A: sa, B: sb });
  }
  expect(lockCombos).toHaveLength(9);

  const cases: Array<{
    mask: number;
    lockIdx: number;
    candIdx: number;
  }> = [];
  for (let mask = 0; mask < 1 << defs.length; mask++) {
    for (let lockIdx = 0; lockIdx < lockCombos.length; lockIdx++) {
      for (let candIdx = 0; candIdx < candidateDefs.length; candIdx++) {
        cases.push({ mask, lockIdx, candIdx });
      }
    }
  }
  expect(cases.length).toBe(16 * 9 * 4);

  it.each(cases)(
    '规则子集 $mask / 锁定#$lockIdx / 候选#$candIdx',
    ({ mask, lockIdx, candIdx }) => {
      const chosen = defs.filter((_, k) => (mask >> k) & 1);
      const locks = lockCombos[lockIdx];
      const [ca, cas, cb, cbs] = candidateDefs[candIdx];
      const ws: Workspace = { ids: [...ids], rules: makeRules(chosen) };
      const clauses: Clause[] = chosen.map(([a, as, b, bs]) => ({
        a: { id: a, state: as },
        b: { id: b, state: bs },
      }));
      const candidate: CandidateRule = {
        a: { id: ca, state: cas },
        b: { id: cb, state: cbs },
        text: `${ca} ${cas} OR ${cb} ${cbs}`,
      };
      const expectedKind = oracleCategorize(ids, clauses, locks, candidate);
      const result = precheckCandidate(ws, locks, candidate);
      expect(result.kind).toBe(expectedKind);

      // 预检绝不修改工作区与锁定
      expect(ws.rules).toHaveLength(chosen.length);
      expect(ws.rules.map((r) => r.index)).toEqual(chosen.map((_, i) => i));
      expect(locks).toEqual(lockCombos[lockIdx]);

      if (result.kind === 'baseline-conflict') {
        // 见证必须与直接求解当前工作区完全一致，且不含任何候选规则边
        const direct = solveWorkspace(ws, locks);
        expect(direct.kind).toBe('unsat');
        if (direct.kind !== 'unsat') throw new Error('oracle 不一致');
        expect(result.baseline.witness).toEqual(direct.witness);
        const used = new Set([
          ...ruleIndicesOf(result.baseline.witness.openToClosed),
          ...ruleIndicesOf(result.baseline.witness.closedToOpen),
        ]);
        for (const idx of used) expect(idx).toBeLessThan(ws.rules.length);
        expectValidPath(
          ws,
          locks,
          direct.witness.id,
          'OPEN',
          result.baseline.witness.openToClosed,
          'CLOSED',
        );
        expectValidPath(
          ws,
          locks,
          direct.witness.id,
          'CLOSED',
          result.baseline.witness.closedToOpen,
          'OPEN',
        );
      } else if (result.kind === 'candidate-conflict') {
        const augmented = withCandidateRule(ws, candidate).workspace;
        expect(augmented.rules).toHaveLength(ws.rules.length + 1);
        // 原视图仍未被修改
        expect(ws.rules).toHaveLength(chosen.length);
        const directAug = solveWorkspace(augmented, locks);
        expect(directAug.kind).toBe('unsat');
        if (directAug.kind !== 'unsat') throw new Error('oracle 不一致');
        expect(result.withCandidate.witness).toEqual(directAug.witness);
        expectValidPath(
          augmented,
          locks,
          directAug.witness.id,
          'OPEN',
          result.withCandidate.witness.openToClosed,
          'CLOSED',
        );
        expectValidPath(
          augmented,
          locks,
          directAug.witness.id,
          'CLOSED',
          result.withCandidate.witness.closedToOpen,
          'OPEN',
        );
        // 一份原锁定下可行、但被候选排除的方案
        const baseExpected = lexMin(ids, (a) => assignmentOk(a, clauses, locks))!;
        expectPlanComplete(ws, result.baselinePlan, locks, baseExpected);
      } else if (result.kind === 'redundant') {
        const baseExpected = lexMin(ids, (a) => assignmentOk(a, clauses, locks))!;
        expectPlanComplete(ws, result.baselinePlan, locks, baseExpected);
        // 规范方案满足候选
        expect(
          assignmentSatisfiesCandidate(result.baselinePlan.assignment, candidate),
        ).toBe(true);
      } else {
        // tightening
        const satExpected = lexMin(ids, (a) =>
          assignmentOk(a, clauses, locks, candidate),
        )!;
        const violExpected = lexMin(ids, (a) => {
          if (!assignmentOk(a, clauses, locks)) return false;
          return (
            a.get(candidate.a.id) !== candidate.a.state &&
            a.get(candidate.b.id) !== candidate.b.state
          );
        })!;
        expectPlanComplete(ws, result.satisfying, locks, satExpected);
        expectPlanComplete(ws, result.violating, locks, violExpected);
        expect(
          assignmentSatisfiesCandidate(result.satisfying.assignment, candidate),
        ).toBe(true);
        expect(
          assignmentViolatesCandidate(result.violating.assignment, candidate),
        ).toBe(true);
        // 两份方案确有差异（否则不构成收紧）
        expect(result.satisfying.assignment).not.toEqual(
          result.violating.assignment,
        );
      }
    },
  );
});

/* ------------- n=3：抽样规则子集 × 锁定组合 × 12 候选，穷举交叉 ------------- */

describe('候选规则预检：n=3 抽样穷举', () => {
  const ids = ['A', 'B', 'C'];
  const STATES: ShutterState[] = ['OPEN', 'CLOSED'];
  const candidateDefs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const si of STATES) for (const sj of STATES) {
        candidateDefs.push([ids[i], si, ids[j], sj]);
      }
    }
  }
  expect(candidateDefs).toHaveLength(12);

  const lockCombos: Array<Record<string, ShutterState>> = [
    {},
    { A: 'OPEN' },
    { B: 'CLOSED' },
    { C: 'OPEN' },
    { A: 'CLOSED', C: 'CLOSED' },
    { A: 'OPEN', B: 'OPEN', C: 'OPEN' },
  ];

  const masks: number[] = [];
  for (let m = 0; m < 1 << candidateDefs.length; m += 13) masks.push(m);
  masks.push((1 << candidateDefs.length) - 1);

  it.each(masks)('规则子集掩码 %# × 全部锁定 × 全部候选', (mask) => {
    const chosen = candidateDefs.filter((_, k) => (mask >> k) & 1);
    const ws: Workspace = { ids: [...ids], rules: makeRules(chosen) };
    const clauses: Clause[] = chosen.map(([a, as, b, bs]) => ({
      a: { id: a, state: as },
      b: { id: b, state: bs },
    }));
    for (const locks of lockCombos) {
      for (const [ca, cas, cb, cbs] of candidateDefs) {
        const candidate: CandidateRule = {
          a: { id: ca, state: cas },
          b: { id: cb, state: cbs },
          text: `${ca} ${cas} OR ${cb} ${cbs}`,
        };
        const expectedKind = oracleCategorize(ids, clauses, locks, candidate);
        const result = precheckCandidate(ws, locks, candidate);
        expect(result.kind).toBe(expectedKind);
        if (result.kind === 'tightening') {
          expect(
            assignmentSatisfiesCandidate(result.satisfying.assignment, candidate),
          ).toBe(true);
          expect(
            assignmentViolatesCandidate(result.violating.assignment, candidate),
          ).toBe(true);
          expect(assignmentRespectsLocks(result.satisfying.assignment, locks)).toBe(true);
          expect(assignmentRespectsLocks(result.violating.assignment, locks)).toBe(true);
        }
      }
    }
  });
});

/* ---------------- 四类结论的定向用例 ---------------- */

describe('候选规则预检：四类结认定向用例', () => {
  it('有效收紧：给规范方案与违反见证，均遵守原锁定', () => {
    // 无规则；锁 A=OPEN。候选 B OPEN ∨ C CLOSED。
    // 满足候选的最小方案：A=OPEN, B=CLOSED, C=CLOSED（C=CLOSED 即满足）。
    // 违反见证（B=CLOSED 且 C=OPEN）：A=OPEN, B=CLOSED, C=OPEN。
    const ws: Workspace = { ids: ['A', 'B', 'C'], rules: [] };
    const locks = { A: 'OPEN' as ShutterState };
    const candidate: CandidateRule = {
      a: { id: 'B', state: 'OPEN' },
      b: { id: 'C', state: 'CLOSED' },
      text: 'B OPEN OR C CLOSED',
    };
    const r = precheckCandidate(ws, locks, candidate);
    expect(r.kind).toBe('tightening');
    if (r.kind !== 'tightening') return;
    expect(r.satisfying.assignment).toEqual({
      A: 'OPEN',
      B: 'CLOSED',
      C: 'CLOSED',
    });
    expect(r.violating.assignment).toEqual({
      A: 'OPEN',
      B: 'CLOSED',
      C: 'OPEN',
    });
    expect(assignmentSatisfiesCandidate(r.satisfying.assignment, candidate)).toBe(true);
    expect(assignmentViolatesCandidate(r.violating.assignment, candidate)).toBe(true);
  });

  it('候选冗余：与已有规则完全相同（重复规则）', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'OPEN' },
      b: { id: 'B', state: 'OPEN' },
      text: 'A OPEN OR B OPEN',
    };
    const r = precheckCandidate(ws, {}, candidate);
    expect(r.kind).toBe('redundant');
    if (r.kind !== 'redundant') return;
    expect(r.baselinePlan.assignment).toEqual({ A: 'CLOSED', B: 'OPEN' });
  });

  it('候选冗余：由两条规则蕴含（无需重复）', () => {
    // ¬(A=OPEN)→... 规则 A CLOSED ∨ B OPEN 与 A OPEN ∨ B OPEN：
    // 合取蕴含 B OPEN（两个子句消去 A），故候选「B OPEN OR C OPEN」也未必……
    // 直接构造蕴含：A CLOSED∨B OPEN 与 A OPEN∨B OPEN ⇒ B 在任何解中为 OPEN。
    // 候选只含 B OPEN 即被蕴含，但二元规则不允许同快门重复，
    // 用「B OPEN OR C OPEN」：B 恒 OPEN 时该候选恒成立。
    const ws: Workspace = {
      ids: ['A', 'B', 'C'],
      rules: makeRules([
        ['A', 'CLOSED', 'B', 'OPEN'],
        ['A', 'OPEN', 'B', 'OPEN'],
      ]),
    };
    const candidate: CandidateRule = {
      a: { id: 'B', state: 'OPEN' },
      b: { id: 'C', state: 'OPEN' },
      text: 'B OPEN OR C OPEN',
    };
    const r = precheckCandidate(ws, {}, candidate);
    expect(r.kind).toBe('redundant');
    if (r.kind !== 'redundant') return;
    expect(r.baselinePlan.assignment.B).toBe('OPEN');
  });

  it('候选因锁定而冗余：候选文字之一已被锁定强制成立', () => {
    const ws: Workspace = { ids: ['A', 'B'], rules: [] };
    const locks = { A: 'OPEN' as ShutterState };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'OPEN' },
      b: { id: 'B', state: 'OPEN' },
      text: 'A OPEN OR B OPEN',
    };
    const r = precheckCandidate(ws, locks, candidate);
    expect(r.kind).toBe('redundant');
  });

  it('候选导致冲突：当前可行，加入候选与锁定矛盾', () => {
    // 无规则本全可行；锁 A=CLOSED、B=CLOSED；候选 A OPEN∨B OPEN → 无解。
    const ws: Workspace = { ids: ['A', 'B'], rules: [] };
    const locks = { A: 'CLOSED' as ShutterState, B: 'CLOSED' as ShutterState };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'OPEN' },
      b: { id: 'B', state: 'OPEN' },
      text: 'A OPEN OR B OPEN',
    };
    const r = precheckCandidate(ws, locks, candidate);
    expect(r.kind).toBe('candidate-conflict');
    if (r.kind !== 'candidate-conflict') return;
    // 原锁定下可行
    expect(r.baselinePlan.assignment).toEqual({ A: 'CLOSED', B: 'CLOSED' });
    // 含候选的见证路径合法，且至少一步引用候选规则（序号 = 原规则数 = 0）
    const augmented = withCandidateRule(ws, candidate).workspace;
    expectValidPath(
      augmented,
      locks,
      r.withCandidate.witness.id,
      'OPEN',
      r.withCandidate.witness.openToClosed,
      'CLOSED',
    );
    const used = new Set([
      ...ruleIndicesOf(r.withCandidate.witness.openToClosed),
      ...ruleIndicesOf(r.withCandidate.witness.closedToOpen),
    ]);
    expect(used.has(0)).toBe(true);
  });

  it('原工作区已冲突：不把旧冲突归咎于候选，见证不含候选边', () => {
    // 规则自身冲突（四子句覆盖 A、B 全部组合）
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([
        ['A', 'OPEN', 'B', 'OPEN'],
        ['A', 'OPEN', 'B', 'CLOSED'],
        ['A', 'CLOSED', 'B', 'OPEN'],
        ['A', 'CLOSED', 'B', 'CLOSED'],
      ]),
    };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'CLOSED' },
      b: { id: 'B', state: 'CLOSED' },
      text: 'A CLOSED OR B CLOSED',
    };
    const r = precheckCandidate(ws, {}, candidate);
    expect(r.kind).toBe('baseline-conflict');
    if (r.kind !== 'baseline-conflict') return;
    const direct = solveWorkspace(ws, {});
    expect(direct.kind).toBe('unsat');
    if (direct.kind !== 'unsat') throw new Error('规则自身应无解');
    expect(r.baseline.witness).toEqual(direct.witness);
    const used = [
      ...ruleIndicesOf(r.baseline.witness.openToClosed),
      ...ruleIndicesOf(r.baseline.witness.closedToOpen),
    ];
    for (const idx of used) expect(idx).toBeLessThan(4); // 候选序号 4 绝不出现
    // 即使候选本身也会制造冲突，只要基线已冲突就必须归入 baseline-conflict
  });

  it('锁定先造成基线冲突：同样归入原工作区冲突', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const locks = { A: 'CLOSED' as ShutterState, B: 'CLOSED' as ShutterState };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'CLOSED' },
      b: { id: 'B', state: 'CLOSED' },
      text: 'A CLOSED OR B CLOSED',
    };
    const r = precheckCandidate(ws, locks, candidate);
    expect(r.kind).toBe('baseline-conflict');
  });

  it('预检全程不改工作区、锁定（含收紧场景）', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const locks = { A: 'OPEN' as ShutterState };
    const snapshot = JSON.stringify({ ws, locks });
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'CLOSED' },
      b: { id: 'B', state: 'CLOSED' },
      text: 'A CLOSED OR B CLOSED',
    };
    precheckCandidate(ws, locks, candidate);
    expect(JSON.stringify({ ws, locks })).toBe(snapshot);
  });

  it('候选加入视图的序号为现有规则数，且视图不与原工作区共享规则数组', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const candidate: CandidateRule = {
      a: { id: 'A', state: 'CLOSED' },
      b: { id: 'B', state: 'CLOSED' },
      text: 'A CLOSED OR B CLOSED',
    };
    const view = withCandidateRule(ws, candidate);
    expect(view.candidateIndex).toBe(1);
    expect(view.workspace.rules).toHaveLength(2);
    expect(view.workspace.rules[1].index).toBe(1);
    expect(ws.rules).toHaveLength(1);
    expect(view.workspace.ids).toBe(ws.ids); // ids 共享即可（未改动）
  });
});

/* ---------------- 候选解析边界（与导入共用 parseRuleLine） ---------------- */

describe('parseCandidateRule：边界与拒绝', () => {
  const ws: Workspace = {
    ids: ['A', 'B', 'OR', '__proto__'],
    rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
  };

  it('合法候选（含省略 OR、小写 or、多余空白）', () => {
    for (const text of ['A CLOSED B OPEN', '  A CLOSED or B OPEN ', 'A CLOSED OR OR OPEN']) {
      const r = parseCandidateRule(text, ws);
      expect(r.ok, text).toBe(true);
      expect(r.rule).not.toBeNull();
    }
  });

  it('空输入与多行被拒绝', () => {
    expect(parseCandidateRule('', ws).ok).toBe(false);
    expect(parseCandidateRule('   \n  # 注释\n', ws).ok).toBe(false);
    const multi = parseCandidateRule('A OPEN OR B OPEN\nA CLOSED OR B CLOSED', ws);
    expect(multi.ok).toBe(false);
    expect(multi.errors.join()).toContain('一行');
  });

  it('未知 ID / 非法状态 / 同规则重复 / 记号错误：与导入同一标准', () => {
    expect(parseCandidateRule('X OPEN OR B OPEN', ws).errors.join()).toContain('未知快门 ID');
    expect(parseCandidateRule('A FOO OR B OPEN', ws).errors.join()).toContain('非法状态');
    expect(parseCandidateRule('A OPEN OR A CLOSED', ws).errors.join()).toContain('重复出现');
    expect(parseCandidateRule('A OPEN B', ws).ok).toBe(false);
    expect(parseCandidateRule('A OPEN OR B CLOSED EXTRA', ws).ok).toBe(false);
    expect(parseCandidateRule('OR A OPEN B CLOSED', ws).ok).toBe(false); // OR 错位
  });

  it('特殊 ID（OR / __proto__）可作为候选文字', () => {
    const r = parseCandidateRule('__proto__ CLOSED OR OR OPEN', ws);
    expect(r.ok).toBe(true);
    expect(r.rule?.a).toEqual({ id: '__proto__', state: 'CLOSED' });
    expect(r.rule?.b).toEqual({ id: 'OR', state: 'OPEN' });
  });

  it('规则数已达 3000 上限时拒绝新增', () => {
    const full: Workspace = {
      ids: ['A', 'B'],
      rules: Array.from({ length: MAX_RULES }, (_, i) => ({
        index: i,
        a: { id: 'A', state: 'OPEN' },
        b: { id: 'B', state: 'OPEN' },
        text: 'A OPEN OR B OPEN',
      })),
    };
    const r = parseCandidateRule('A CLOSED OR B CLOSED', full);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain(String(MAX_RULES));
  });

  it('上限前最后一条允许通过', () => {
    const almost: Workspace = {
      ids: ['A', 'B'],
      rules: Array.from({ length: MAX_RULES - 1 }, (_, i) => ({
        index: i,
        a: { id: 'A', state: 'OPEN' },
        b: { id: 'B', state: 'OPEN' },
        text: 'A OPEN OR B OPEN',
      })),
    };
    const r = parseCandidateRule('A CLOSED OR B CLOSED', almost);
    expect(r.ok).toBe(true);
  });
});

/* ---------------- 特殊 ID 的收紧穷举 ---------------- */

describe('候选预检：特殊 ID（__proto__ / OR）穷举', () => {
  const ids = ['__proto__', 'OR'];
  const defs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (const sa of ['OPEN', 'CLOSED'] as ShutterState[]) {
    for (const sb of ['OPEN', 'CLOSED'] as ShutterState[]) {
      defs.push(['__proto__', sa, 'OR', sb]);
    }
  }
  const locks: Record<string, ShutterState> = Object.fromEntries(
    [['__proto__', 'OPEN']] as Array<[string, ShutterState]>,
  );

  it.each([0, 1, 2, 3, 4, 5, 8, 15])('规则掩码 %# × 4 候选', (mask) => {
    const chosen = defs.filter((_, k) => (mask >> k) & 1);
    const ws: Workspace = { ids: [...ids], rules: makeRules(chosen) };
    for (const [ca, cas, cb, cbs] of defs) {
      const candidate: CandidateRule = {
        a: { id: ca, state: cas },
        b: { id: cb, state: cbs },
        text: `${ca} ${cas} OR ${cb} ${cbs}`,
      };
      const clauses: Clause[] = chosen.map(([a, as, b, bs]) => ({
        a: { id: a, state: as },
        b: { id: b, state: bs },
      }));
      const kind = oracleCategorize(ids, clauses, locks, candidate);
      const r = precheckCandidate(ws, locks, candidate);
      expect(r.kind).toBe(kind);
      if (r.kind === 'tightening') {
        expect(Object.prototype.hasOwnProperty.call(r.satisfying.assignment, '__proto__')).toBe(true);
        expect(r.satisfying.assignment['__proto__']).toBe('OPEN');
        expect(r.violating.assignment['__proto__']).toBe('OPEN');
      }
    }
  });
});
