import { describe, expect, it } from 'vitest';
import type {
  CandidateRule,
  Edge,
  ImplicationStep,
  Literal,
  Rule,
  ShutterState,
  Workspace,
} from './types';
import { precheckCandidateRule, validateCandidateRule } from './precheck';
import { MAX_RULES } from './parser';
import { compareUtf8 } from './utf8';

/* ---------- 独立暴力枚举 oracle（不经过蕴含图 / Tarjan，Map 承载以兼容特殊 ID） ---------- */

const STATES: ShutterState[] = ['OPEN', 'CLOSED'];

interface ClauseLike {
  a: Literal;
  b: Literal;
}

function assignmentSatisfies(
  rules: ClauseLike[],
  locks: Record<string, ShutterState>,
  a: Map<string, ShutterState>,
): boolean {
  for (const [id, s] of Object.entries(locks)) {
    if (a.get(id) !== s) return false;
  }
  for (const r of rules) {
    if (a.get(r.a.id) !== r.a.state && a.get(r.b.id) !== r.b.state) return false;
  }
  return true;
}

/** 按「ID 的 UTF-8 字节序、CLOSED(0) 优先」枚举全部 2ⁿ 个赋值。 */
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

function bruteLexMin(
  ids: string[],
  rules: ClauseLike[],
  locks: Record<string, ShutterState>,
): Record<string, ShutterState> | null {
  for (const a of enumerateAssignments(ids)) {
    if (assignmentSatisfies(rules, locks, a)) return Object.fromEntries(a);
  }
  return null;
}

function violatesCandidate(
  candidate: CandidateRule,
  a: Map<string, ShutterState>,
): boolean {
  return (
    a.get(candidate.a.id) !== candidate.a.state &&
    a.get(candidate.b.id) !== candidate.b.state
  );
}

/** 当前可行（满足规则与锁定）但违反候选的字典序最小赋值；不存在为 null。 */
function bruteLexMinViolating(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  candidate: CandidateRule,
): Record<string, ShutterState> | null {
  for (const a of enumerateAssignments(ws.ids)) {
    if (!assignmentSatisfies(ws.rules, locks, a)) continue;
    if (violatesCandidate(candidate, a)) return Object.fromEntries(a);
  }
  return null;
}

type PrecheckKind =
  | 'base-conflict'
  | 'candidate-conflict'
  | 'redundant'
  | 'tightens';

/** 独立分类 oracle：完全由暴力枚举赋值得出，与蕴含图实现无关。 */
function classifyOracle(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  candidate: CandidateRule,
): PrecheckKind {
  if (bruteLexMin(ws.ids, ws.rules, locks) === null) return 'base-conflict';
  if (bruteLexMin(ws.ids, [...ws.rules, candidate], locks) === null) {
    return 'candidate-conflict';
  }
  return bruteLexMinViolating(ws, locks, candidate) !== null
    ? 'tightens'
    : 'redundant';
}

/* ---------------- 见证路径逐边校验（复刻 sat.test.ts 的校验，扩展候选规则） ---------------- */

function edgesOf(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  extra?: Rule,
): Edge[] {
  const sorted = [...ws.ids].sort(compareUtf8);
  const idx = new Map(sorted.map((id, i) => [id, i]));
  const node = (id: string, s: ShutterState) =>
    2 * idx.get(id)! + (s === 'CLOSED' ? 1 : 0);
  const edges: Edge[] = [];
  const rules = extra ? [...ws.rules, extra] : ws.rules;
  for (const r of rules) {
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

function flip(s: ShutterState): ShutterState {
  return s === 'OPEN' ? 'CLOSED' : 'OPEN';
}

/** 校验见证路径：端点正确、每步是蕴含图真实边、rule 依据指回真正蕴含它的规则（含候选）。 */
function expectValidPath(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  extra: Rule | null,
  startId: string,
  startState: ShutterState,
  steps: ImplicationStep[],
  endState: ShutterState,
) {
  const edgeSet = new Set(
    edgesOf(ws, locks, extra ?? undefined).map((e) => `${e.from}->${e.to}`),
  );
  const sorted = [...ws.ids].sort(compareUtf8);
  const nodeLit = (id: string, s: ShutterState) =>
    2 * sorted.indexOf(id) + (s === 'CLOSED' ? 1 : 0);
  if (steps.length === 0) {
    expect(startState).toBe(endState);
    return;
  }
  expect(steps[0].from).toEqual({ id: startId, state: startState });
  expect(steps[steps.length - 1].to).toEqual({ id: startId, state: endState });
  for (let k = 0; k < steps.length; k++) {
    const step = steps[k];
    const key = `${nodeLit(step.from.id, step.from.state)}->${nodeLit(
      step.to.id,
      step.to.state,
    )}`;
    expect(edgeSet.has(key), `见证边 ${key} 必须真实存在于蕴含图`).toBe(true);
    if (k > 0) expect(step.from).toEqual(steps[k - 1].to);
    if (step.reason.kind === 'rule') {
      const r =
        step.reason.ruleIndex < ws.rules.length
          ? ws.rules[step.reason.ruleIndex]
          : extra && step.reason.ruleIndex === extra.index
            ? extra
            : null;
      expect(r, '每一步都必须指回真实规则或候选规则').not.toBeNull();
      const isFirst =
        r!.a.id === step.from.id && flip(r!.a.state) === step.from.state &&
        r!.b.id === step.to.id && r!.b.state === step.to.state;
      const isSecond =
        r!.b.id === step.from.id && flip(r!.b.state) === step.from.state &&
        r!.a.id === step.to.id && r!.a.state === step.to.state;
      expect(isFirst || isSecond, '每一步都必须指回真正蕴含它的原规则').toBe(true);
    }
  }
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

function makeCandidate(
  aid: string,
  as: ShutterState,
  bid: string,
  bs: ShutterState,
): CandidateRule {
  return {
    a: { id: aid, state: as },
    b: { id: bid, state: bs },
    text: `${aid} ${as} OR ${bid} ${bs}`,
  };
}

/** 预检结论必须与独立暴力 oracle 一致，且各类结论的产物（见证 / 方案）逐项合法。 */
function expectPrecheckMatchesOracle(
  ws: Workspace,
  locks: Record<string, ShutterState>,
  candidate: CandidateRule,
) {
  const result = precheckCandidateRule(ws, locks, candidate);
  const expected = classifyOracle(ws, locks, candidate);
  expect(result.kind).toBe(expected);

  if (result.kind === 'base-conflict') {
    const w = result.witness;
    // 旧冲突的见证必须完全来自原图：不允许出现候选规则的边
    expectValidPath(ws, locks, null, w.id, 'OPEN', w.openToClosed, 'CLOSED');
    expectValidPath(ws, locks, null, w.id, 'CLOSED', w.closedToOpen, 'OPEN');
    for (const s of [...w.openToClosed, ...w.closedToOpen]) {
      if (s.reason.kind === 'rule') {
        expect(
          s.reason.ruleIndex,
          '原工作区已冲突时，见证不能把旧冲突归咎于候选规则',
        ).toBeLessThan(ws.rules.length);
      }
    }
    return;
  }

  if (result.kind === 'candidate-conflict') {
    const extRule: Rule = { index: ws.rules.length, ...candidate };
    const w = result.witness;
    // 见证在「原规则 + 候选」的扩展图上逐步合法
    expectValidPath(ws, locks, extRule, w.id, 'OPEN', w.openToClosed, 'CLOSED');
    expectValidPath(ws, locks, extRule, w.id, 'CLOSED', w.closedToOpen, 'OPEN');
    // 原图本可满足，故两条路径中至少一步必须真正指回候选规则
    const involves = [...w.openToClosed, ...w.closedToOpen].some(
      (s) => s.reason.kind === 'rule' && s.reason.ruleIndex === ws.rules.length,
    );
    expect(involves, '候选导致冲突时，见证必须指回候选规则').toBe(true);
    return;
  }

  if (result.kind === 'redundant') return;

  // tightens：规范方案与违反见证双双核对
  const { plan, counterexample } = result;

  // 规范方案 = 加入候选后的 CLOSED 优先字典序最小完整方案
  const wantPlan = bruteLexMin(ws.ids, [...ws.rules, candidate], locks)!;
  expect(plan.assignment).toEqual(wantPlan);
  expect(Object.keys(plan.assignment).sort()).toEqual([...ws.ids].sort());
  expect(
    plan.assignment[candidate.a.id] === candidate.a.state ||
      plan.assignment[candidate.b.id] === candidate.b.state,
    '规范方案必须满足候选',
  ).toBe(true);
  for (const [id, s] of Object.entries(locks)) {
    expect(plan.assignment[id], `规范方案必须遵守原锁定 ${id}=${s}`).toBe(s);
  }

  // 违反见证 = 当前合法但违反候选的字典序最小组合，同样遵守原锁定
  const wantCx = bruteLexMinViolating(ws, locks, candidate)!;
  expect(counterexample.assignment).toEqual(wantCx);
  expect(Object.keys(counterexample.assignment).sort()).toEqual([...ws.ids].sort());
  expect(counterexample.assignment[candidate.a.id]).not.toBe(candidate.a.state);
  expect(counterexample.assignment[candidate.b.id]).not.toBe(candidate.b.state);
  for (const [id, s] of Object.entries(locks)) {
    expect(counterexample.assignment[id], `违反见证必须遵守原锁定 ${id}=${s}`).toBe(s);
  }
}

/* ---------------- n=2 全量穷举：16 规则子集 × 9 锁定组合 × 4 候选 ---------------- */

describe('候选预检：n=2 全部规则子集 × 全部锁定 × 全部候选穷举', () => {
  const ids = ['A', 'B'];
  const defs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (const sa of STATES) for (const sb of STATES) defs.push(['A', sa, 'B', sb]);
  expect(defs).toHaveLength(4);

  const lockCombos: Array<Record<string, ShutterState>> = [];
  for (const la of [null, ...STATES] as const) {
    for (const lb of [null, ...STATES] as const) {
      const locks: Record<string, ShutterState> = {};
      if (la) locks.A = la;
      if (lb) locks.B = lb;
      lockCombos.push(locks);
    }
  }
  expect(lockCombos).toHaveLength(9);

  const masks: number[] = [];
  for (let m = 0; m < 1 << defs.length; m++) masks.push(m);

  it.each(masks)('规则子集掩码 %#', (mask) => {
    const chosen = defs.filter((_, k) => (mask >> k) & 1);
    const ws: Workspace = { ids: [...ids], rules: makeRules(chosen) };
    for (const locks of lockCombos) {
      for (const [aid, as, bid, bs] of defs) {
        expectPrecheckMatchesOracle(ws, locks, makeCandidate(aid, as, bid, bs));
      }
    }
  });
});

/* ---------------- n=3 抽样穷举：规则子集 × 27 锁定组合 × 12 候选 ---------------- */

describe('候选预检：n=3 规则子集 × 27 种锁定 × 12 种候选抽样穷举', () => {
  const ids = ['A', 'B', 'C'];
  const candidateDefs: Array<[string, ShutterState, string, ShutterState]> = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const si of STATES) {
        for (const sj of STATES) candidateDefs.push([ids[i], si, ids[j], sj]);
      }
    }
  }
  expect(candidateDefs).toHaveLength(12);

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
  for (let m = 0; m < 1 << candidateDefs.length; m += 13) masks.push(m);
  masks.push((1 << candidateDefs.length) - 1);

  it.each(masks)('规则子集掩码 %#', (mask) => {
    const defs = candidateDefs.filter((_, k) => (mask >> k) & 1);
    const ws: Workspace = { ids: [...ids], rules: makeRules(defs) };
    for (const locks of lockCombos) {
      for (const [aid, as, bid, bs] of candidateDefs) {
        expectPrecheckMatchesOracle(ws, locks, makeCandidate(aid, as, bid, bs));
      }
    }
  });
});

/* ---------------- 四类结论与边界的定向用例 ---------------- */

describe('候选预检：四类结论定向用例', () => {
  it('同一可行工作区上，不同候选分别触发收紧 / 冗余 / 候选冲突', () => {
    // 规则：A OPEN ∨ B OPEN（禁止双 CLOSED）
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    // 有效收紧：候选 A CLOSED ∨ B CLOSED 排除当前合法的 A=OPEN,B=OPEN
    const tightens = precheckCandidateRule(ws, {}, makeCandidate('A', 'CLOSED', 'B', 'CLOSED'));
    expect(tightens.kind).toBe('tightens');
    if (tightens.kind === 'tightens') {
      expect(tightens.counterexample.assignment).toEqual({ A: 'OPEN', B: 'OPEN' });
      expect(tightens.plan.assignment).toEqual({ A: 'CLOSED', B: 'OPEN' });
    }
    // 冗余：候选与现有规则重复
    expect(precheckCandidateRule(ws, {}, makeCandidate('A', 'OPEN', 'B', 'OPEN')).kind).toBe(
      'redundant',
    );
    // 候选导致冲突：锁 A=CLOSED 后，候选 A OPEN ∨ B CLOSED 与规则联合无解
    expect(
      precheckCandidateRule(ws, { A: 'CLOSED' }, makeCandidate('A', 'OPEN', 'B', 'CLOSED')).kind,
    ).toBe('candidate-conflict');
  });

  it('原工作区已冲突：任何候选都报 base-conflict，见证不含候选', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([
        ['A', 'OPEN', 'B', 'OPEN'],
        ['A', 'OPEN', 'B', 'CLOSED'],
        ['A', 'CLOSED', 'B', 'OPEN'],
        ['A', 'CLOSED', 'B', 'CLOSED'],
      ]),
    };
    for (const candidate of [
      makeCandidate('A', 'OPEN', 'B', 'OPEN'),
      makeCandidate('A', 'CLOSED', 'B', 'CLOSED'),
    ]) {
      const result = precheckCandidateRule(ws, { A: 'OPEN' }, candidate);
      expect(result.kind).toBe('base-conflict');
      if (result.kind !== 'base-conflict') continue;
      expectValidPath(ws, { A: 'OPEN' }, null, result.witness.id, 'OPEN', result.witness.openToClosed, 'CLOSED');
      expectValidPath(ws, { A: 'OPEN' }, null, result.witness.id, 'CLOSED', result.witness.closedToOpen, 'OPEN');
    }
  });

  it('锁定使候选文字恒成立 → 冗余（不构造违反见证）', () => {
    const ws: Workspace = { ids: ['A', 'B'], rules: [] };
    expect(
      precheckCandidateRule(ws, { A: 'OPEN' }, makeCandidate('A', 'OPEN', 'B', 'CLOSED')).kind,
    ).toBe('redundant');
  });

  it('锁定恰为候选文字的否定：违反见证沿用该锁定且遵守之', () => {
    const ws: Workspace = { ids: ['A', 'B'], rules: [] };
    const result = precheckCandidateRule(ws, { A: 'CLOSED' }, makeCandidate('A', 'OPEN', 'B', 'OPEN'));
    expect(result.kind).toBe('tightens');
    if (result.kind !== 'tightens') return;
    // 见证：A=CLOSED 来自原锁定（不得被翻转），B=CLOSED 为候选否定
    expect(result.counterexample.assignment).toEqual({ A: 'CLOSED', B: 'CLOSED' });
    // 规范方案遵守同一锁定：A 仍为 CLOSED，B 必须 OPEN
    expect(result.plan.assignment).toEqual({ A: 'CLOSED', B: 'OPEN' });
  });

  it('候选与锁定直接矛盾 → 候选导致冲突，见证指回候选规则', () => {
    const ws: Workspace = { ids: ['A', 'B'], rules: [] };
    const result = precheckCandidateRule(
      ws,
      { A: 'OPEN', B: 'CLOSED' },
      makeCandidate('A', 'CLOSED', 'B', 'OPEN'),
    );
    expect(result.kind).toBe('candidate-conflict');
    if (result.kind !== 'candidate-conflict') return;
    const steps = [...result.witness.openToClosed, ...result.witness.closedToOpen];
    expect(
      steps.some((s) => s.reason.kind === 'rule' && s.reason.ruleIndex === 0),
    ).toBe(true);
  });

  it('预检不改动工作区、规则与锁定输入', () => {
    const ws: Workspace = {
      ids: ['A', 'B'],
      rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
    };
    const locks: Record<string, ShutterState> = { A: 'CLOSED' };
    const snapshot = JSON.stringify({ ws, locks });
    precheckCandidateRule(ws, locks, makeCandidate('A', 'OPEN', 'B', 'CLOSED'));
    expect(JSON.stringify({ ws, locks })).toBe(snapshot);
  });
});

/* ---------------- 特殊快门 ID ---------------- */

describe('候选预检：特殊快门 ID（__proto__ / OR）', () => {
  it('特殊 ID 作为候选文字：方案与见证完整、遵守锁定且为自有条目', () => {
    const ws: Workspace = { ids: ['__proto__', 'OR'], rules: [] };
    const locks = Object.fromEntries([
      ['OR', 'CLOSED'],
    ]) as Record<string, ShutterState>;
    const result = precheckCandidateRule(
      ws,
      locks,
      makeCandidate('__proto__', 'OPEN', 'OR', 'OPEN'),
    );
    expect(result.kind).toBe('tightens');
    if (result.kind !== 'tightens') return;
    // 锁 OR=CLOSED → 规范方案中 __proto__ 必须 OPEN；两者都是独立自有条目
    for (const id of ['__proto__', 'OR']) {
      expect(Object.prototype.hasOwnProperty.call(result.plan.assignment, id)).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(result.counterexample.assignment, id)).toBe(true);
    }
    expect(result.plan.assignment['__proto__']).toBe('OPEN');
    expect(result.plan.assignment['OR']).toBe('CLOSED');
    // 违反见证：两个文字均不成立，且遵守 OR=CLOSED 锁定
    expect(result.counterexample.assignment['__proto__']).toBe('CLOSED');
    expect(result.counterexample.assignment['OR']).toBe('CLOSED');
  });

  it('锁定 __proto__ 为候选文字成立值 → 冗余', () => {
    const ws: Workspace = { ids: ['__proto__', 'OR'], rules: [] };
    const locks = Object.fromEntries([
      ['__proto__', 'OPEN'],
    ]) as Record<string, ShutterState>;
    expect(
      precheckCandidateRule(ws, locks, makeCandidate('__proto__', 'OPEN', 'OR', 'CLOSED')).kind,
    ).toBe('redundant');
  });
});

/* ---------------- 候选文本校验 ---------------- */

describe('候选规则文本校验', () => {
  const ws: Workspace = {
    ids: ['A', 'B'],
    rules: makeRules([['A', 'OPEN', 'B', 'OPEN']]),
  };

  it('合法候选通过（OR 可省略、可小写、可重复，多余空白容忍）', () => {
    for (const text of [
      'A OPEN OR B CLOSED',
      'A OPEN B CLOSED',
      'A OPEN or B CLOSED',
      'A OPEN OR OR B CLOSED',
      '  A OPEN   OR   B CLOSED  ',
    ]) {
      const v = validateCandidateRule(text, ws);
      expect(v.errors, `「${text}」应通过`).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v.candidate).toMatchObject({
        a: { id: 'A', state: 'OPEN' },
        b: { id: 'B', state: 'CLOSED' },
      });
    }
  });

  it('空文本 / 纯注释 / 多行均拒绝', () => {
    for (const text of ['', '   ', '# 注释', 'A OPEN OR B CLOSED\nB OPEN OR A CLOSED']) {
      const v = validateCandidateRule(text, ws);
      expect(v.ok, `「${text}」应被拒绝`).toBe(false);
      expect(v.candidate).toBeNull();
      expect(v.errors.length).toBeGreaterThan(0);
    }
  });

  it('未知 ID / 非法状态 / 同规则内重复 / 记号数量错误均拒绝', () => {
    const bad: Array<[string, string]> = [
      ['X OPEN OR B CLOSED', '未知快门 ID'],
      ['A OPENED OR B CLOSED', '非法状态'],
      ['A OPEN OR A CLOSED', '重复出现'],
      ['A OPEN OR B CLOSED EXTRA', '记号'],
      ['A OPEN B', '记号'],
      ['OR A OPEN B CLOSED', '记号'],
    ];
    for (const [text, fragment] of bad) {
      const v = validateCandidateRule(text, ws);
      expect(v.ok, `「${text}」应被拒绝`).toBe(false);
      expect(v.errors.join('\n')).toContain(fragment);
    }
  });

  it('OR 作为快门 ID 的候选解析', () => {
    const wsOr: Workspace = { ids: ['OR', 'S1'], rules: [] };
    const v = validateCandidateRule('OR OPEN OR S1 CLOSED', wsOr);
    expect(v.ok).toBe(true);
    expect(v.candidate).toMatchObject({
      a: { id: 'OR', state: 'OPEN' },
      b: { id: 'S1', state: 'CLOSED' },
    });
  });

  it('规则数达上限时拒绝新增；语法错误与上限同时报告', () => {
    const full: Workspace = {
      ids: ['A', 'B'],
      rules: Array.from({ length: MAX_RULES }, (_, i) => ({
        index: i,
        a: { id: 'A', state: 'OPEN' },
        b: { id: 'B', state: 'OPEN' },
        text: 'A OPEN OR B OPEN',
      })),
    };
    const v = validateCandidateRule('A OPEN OR B CLOSED', full);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain('已达上限');
    const v2 = validateCandidateRule('X OPEN', full);
    expect(v2.errors.length).toBeGreaterThanOrEqual(2);
    // 差一条未到上限：仍可通过
    const almost: Workspace = { ids: full.ids, rules: full.rules.slice(0, MAX_RULES - 1) };
    expect(validateCandidateRule('A OPEN OR B CLOSED', almost).ok).toBe(true);
  });
});

/* ---------------- 规模与性能 ---------------- */

describe('候选预检：规模与性能（300 快门 / 3000 规则）', () => {
  it('上限规模下单次预检在合理时间内完成', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `SH-${String(i).padStart(3, '0')}`);
    const defs: Array<[string, ShutterState, string, ShutterState]> = [];
    for (let k = 0; k < 3000; k++) {
      const i = k % 299;
      const j = (i + 1 + ((k / 299) | 0)) % 300;
      // 每条子句都含 CLOSED 文字，保证“全 CLOSED”是可行方案
      defs.push([ids[i], STATES[k & 1], ids[j], 'CLOSED']);
    }
    const ws: Workspace = { ids, rules: makeRules(defs) };
    const started = Date.now();
    const result = precheckCandidateRule(
      ws,
      {},
      makeCandidate('SH-000', 'CLOSED', 'SH-150', 'CLOSED'),
    );
    const elapsed = Date.now() - started;
    // 三次完整求解（当前 / 加候选 / 违反探测），留足裕量
    expect(elapsed).toBeLessThan(30000);
    // 违反候选需 SH-000=OPEN 且 SH-150=OPEN，与其余规则相容 → 有效收紧
    expect(result.kind).toBe('tightens');
    if (result.kind !== 'tightens') return;
    expect(result.counterexample.assignment['SH-000']).toBe('OPEN');
    expect(result.counterexample.assignment['SH-150']).toBe('OPEN');
    expect(Object.keys(result.plan.assignment)).toHaveLength(300);
    expect(Object.keys(result.counterexample.assignment)).toHaveLength(300);
  });

  it('上限规模下候选冗余也能在合理时间内判定', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `SH-${String(i).padStart(3, '0')}`);
    const defs: Array<[string, ShutterState, string, ShutterState]> = [];
    for (let k = 0; k < 3000; k++) {
      const i = k % 299;
      const j = (i + 1 + ((k / 299) | 0)) % 300;
      defs.push([ids[i], STATES[k & 1], ids[j], 'CLOSED']);
    }
    const ws: Workspace = { ids, rules: makeRules(defs) };
    // SH-000=OPEN 经规则链蕴含 SH-001=CLOSED，故该候选被现有规则蕴含 → 冗余
    const started = Date.now();
    const result = precheckCandidateRule(
      ws,
      {},
      makeCandidate('SH-000', 'CLOSED', 'SH-001', 'CLOSED'),
    );
    expect(Date.now() - started).toBeLessThan(30000);
    expect(result.kind).toBe('redundant');
  });
});
