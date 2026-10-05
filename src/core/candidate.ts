import type {
  Rule,
  ShutterState,
  SolveOutcome,
  Workspace,
} from './types';
import { solveWorkspace } from './sat';

/** 候选规则预检的输入：候选行已由 parser.parseCandidateRule 解析通过。 */
export interface CandidateRule {
  a: { id: string; state: ShutterState };
  b: { id: string; state: ShutterState };
  text: string;
}

/** 加入候选后的工作区视图（不修改原工作区；候选规则序号取现有规则数）。 */
export interface CandidateWorkspace {
  candidateIndex: number;
  workspace: Workspace;
}

export type CandidatePrecheck =
  | {
      kind: 'baseline-conflict';
      /** 当前规则 + 锁定本就无解：沿用原蕴含路径见证，候选未被归咎 */
      baseline: Extract<SolveOutcome, { kind: 'unsat' }>;
    }
  | {
      kind: 'candidate-conflict';
      /** 当前本可行；加入候选后无解：见证蕴含图包含候选规则边 */
      withCandidate: Extract<SolveOutcome, { kind: 'unsat' }>;
      /** 原锁定下仍可行的一份方案，证明冲突由候选引入 */
      baselinePlan: Extract<SolveOutcome, { kind: 'sat' }>;
    }
  | {
      kind: 'redundant';
      /** 候选被原规则 + 锁定蕴含：所有当前可行方案都已满足它 */
      baselinePlan: Extract<SolveOutcome, { kind: 'sat' }>;
    }
  | {
      kind: 'tightening';
      /** 原锁定下满足候选的字典序最小（CLOSED 优先）完整方案 */
      satisfying: Extract<SolveOutcome, { kind: 'sat' }>;
      /** 原锁定下违反候选的字典序最小完整方案：可复核的被排除方案 */
      violating: Extract<SolveOutcome, { kind: 'sat' }>;
    };

function opposite(s: ShutterState): ShutterState {
  return s === 'OPEN' ? 'CLOSED' : 'OPEN';
}

/**
 * 构造「原规则 + 候选规则」的工作区视图：原对象保持不变，候选以追加方式
 * 放在末尾，序号取现有规则数（与确认新增后的真实序号一致）。
 */
export function withCandidateRule(
  workspace: Workspace,
  candidate: CandidateRule,
): CandidateWorkspace {
  const candidateIndex = workspace.rules.length;
  const rule: Rule = { index: candidateIndex, ...candidate };
  return {
    candidateIndex,
    workspace: {
      ids: workspace.ids,
      rules: [...workspace.rules, rule],
    },
  };
}

/**
 * 候选二元规则预检。全程不修改工作区、锁定与快门表，只在临时视图上求解。
 *
 * 裁决分类：
 * - baseline-conflict：当前规则与锁定已无解。沿用当前蕴含图的冲突闭环见证，
 *   其中只含原规则与锁定边，绝不把旧冲突归咎于候选；
 * - candidate-conflict：当前可行、加入候选后无解。见证来自含候选的蕴含图，
 *   并附一份原锁定下的可行方案，证明冲突确由候选引入；
 * - redundant：加入候选仍可行，但原规则 + 锁定的字典序最小方案已满足候选，
 *   且不存在任何违反候选的可行赋值（候选被蕴含）；
 * - tightening：存在违反候选的可行赋值。返回一份满足候选的规范方案
 *   （加入候选后的 CLOSED 优先字典序最小解）与一份违反候选的可复核见证
 *   （原规则 + 锁定下、强制两个候选文字同时不成立时的字典序最小解）。
 *   两份方案均遵守原锁定。
 *
 * 违反见证的构造：规则 a∨b 被违反当且仅当 a、b 同时不成立。把这两个相反值
 * 作为临时单位锁定并入原锁定（任一与既有锁定冲突则违反赋值根本不存在，
 * 候选必为冗余），再由原 2-SAT 求解器给出完整方案；该方案遵守原锁定。
 */
export function precheckCandidate(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
  candidate: CandidateRule,
): CandidatePrecheck {
  const baseline = solveWorkspace(workspace, locks);
  if (baseline.kind === 'unsat') {
    // 旧冲突沿用旧见证：候选从未进入该蕴含图，不能把冲突归咎于新规则。
    return { kind: 'baseline-conflict', baseline };
  }

  const { workspace: augmented } = withCandidateRule(workspace, candidate);
  const withCandidate = solveWorkspace(augmented, locks);
  if (withCandidate.kind === 'unsat') {
    return { kind: 'candidate-conflict', withCandidate, baselinePlan: baseline };
  }

  // 构造「违反候选」的强制条件：两个文字同时取反。
  // 先拷贝原锁定，仅在不与既有锁定冲突时补入反向单位；
  // 一旦某个候选文字已被锁为其要求的状态，违反赋值即不存在 → 候选冗余。
  const violatingLocks: Record<string, ShutterState> = { ...locks };
  const force: Array<{ id: string; state: ShutterState }> = [
    { id: candidate.a.id, state: opposite(candidate.a.state) },
    { id: candidate.b.id, state: opposite(candidate.b.state) },
  ];
  for (const { id, state } of force) {
    const existing = locks[id];
    if (existing !== undefined && existing !== state) {
      // 该候选文字被锁定强制成立，违反候选的赋值不可能存在
      return { kind: 'redundant', baselinePlan: baseline };
    }
    violatingLocks[id] = state;
  }

  const violating = solveWorkspace(workspace, violatingLocks);
  if (violating.kind === 'unsat') {
    // 原规则 + 锁定已蕴含候选：没有任何方案违反它
    return { kind: 'redundant', baselinePlan: baseline };
  }

  return {
    kind: 'tightening',
    satisfying: withCandidate,
    violating,
  };
}

/** 判定某完整方案是否违反候选规则（两个文字同时不成立）。 */
export function assignmentViolatesCandidate(
  assignment: Record<string, ShutterState>,
  candidate: CandidateRule,
): boolean {
  return (
    assignment[candidate.a.id] !== candidate.a.state &&
    assignment[candidate.b.id] !== candidate.b.state
  );
}

/** 判定某完整方案是否满足候选规则（至少一个文字成立）。 */
export function assignmentSatisfiesCandidate(
  assignment: Record<string, ShutterState>,
  candidate: CandidateRule,
): boolean {
  return !assignmentViolatesCandidate(assignment, candidate);
}

/** 方案是否逐把遵守给定锁定（预检返回的方案须满足）。 */
export function assignmentRespectsLocks(
  assignment: Record<string, ShutterState>,
  locks: Record<string, ShutterState>,
): boolean {
  for (const [id, state] of Object.entries(locks)) {
    if (assignment[id] !== state) return false;
  }
  return true;
}
