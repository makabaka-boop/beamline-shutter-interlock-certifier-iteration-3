import type {
  CandidatePrecheck,
  CandidateRule,
  Rule,
  ShutterState,
  Workspace,
} from './types';
import { MAX_RULES, parseCandidateRule } from './parser';
import { solveWorkspace } from './sat';

export interface CandidateValidation {
  ok: boolean;
  errors: string[];
  candidate: CandidateRule | null;
}

/**
 * 校验候选规则文本：语法与整份导入完全一致（parseCandidateRule），
 * 且新增后不得超过规则条数上限。通过后方可进入 precheckCandidateRule。
 */
export function validateCandidateRule(
  text: string,
  workspace: Workspace,
): CandidateValidation {
  const parsed = parseCandidateRule(text, workspace.ids);
  const errors = [...parsed.errors];
  if (workspace.rules.length >= MAX_RULES) {
    errors.push(`规则数量已达上限 ${MAX_RULES} 条，无法新增候选规则`);
  }
  if (errors.length > 0 || !parsed.rule) {
    return { ok: false, errors, candidate: null };
  }
  return { ok: true, errors: [], candidate: parsed.rule };
}

function flip(s: ShutterState): ShutterState {
  return s === 'OPEN' ? 'CLOSED' : 'OPEN';
}

/**
 * 候选规则预检：不修改工作区，复用同一套 2-SAT 语义分别裁决——
 *   1. 当前规则 + 锁定的可行性；
 *   2. 加入候选后的可行性（候选作为最后一条规则参与构图）；
 *   3. 当前可行方案中是否存在违反候选者（违反 a∨b 即 ¬a∧¬b，
 *      把两个否定文字作为额外单位约束并入求解，原锁定一律保留且优先）。
 *
 * 四类结论互斥且穷尽：
 *   - 当前已无解 → base-conflict，见证完全来自现有规则与锁定；
 *   - 当前可行、加入候选后无解 → candidate-conflict，见证可指回候选；
 *   - 两者均可行但不存在违反候选的当前方案 → redundant；
 *   - 否则 → tightens，给出满足候选的规范方案与违反候选的可复核见证，
 *     两份都遵守原锁定。
 *
 * 调用前须经 validateCandidateRule 校验（候选引用的 ID 均已声明）。
 */
export function precheckCandidateRule(
  workspace: Workspace,
  locks: Record<string, ShutterState>,
  candidate: CandidateRule,
): CandidatePrecheck {
  // 1. 当前工作区已冲突：见证在不含候选的原图上求得，与候选无关
  const base = solveWorkspace(workspace, locks);
  if (base.kind === 'unsat') {
    return { kind: 'base-conflict', witness: base.witness };
  }

  // 2. 加入候选后的可行性：候选以序号「原规则数」作为最后一条规则
  const candidateRule: Rule = {
    index: workspace.rules.length,
    a: candidate.a,
    b: candidate.b,
    text: candidate.text,
  };
  const extended: Workspace = {
    ids: workspace.ids,
    rules: [...workspace.rules, candidateRule],
  };
  const tightened = solveWorkspace(extended, locks);
  if (tightened.kind === 'unsat') {
    return { kind: 'candidate-conflict', witness: tightened.witness };
  }

  // 3. 是否存在「当前可行但违反候选」的方案。原锁定优先：
  //    若某文字已被锁定为其成立值，任何遵守锁定的方案都满足候选；
  //    若已锁为其否定值，则该否定约束已由锁定表达，无需重复添加。
  const lockOf = new Map<string, ShutterState>(Object.entries(locks));
  if (
    lockOf.get(candidate.a.id) === candidate.a.state ||
    lockOf.get(candidate.b.id) === candidate.b.state
  ) {
    return { kind: 'redundant' };
  }
  const extra: Array<[string, ShutterState]> = [];
  if (!lockOf.has(candidate.a.id)) {
    extra.push([candidate.a.id, flip(candidate.a.state)]);
  }
  if (!lockOf.has(candidate.b.id)) {
    extra.push([candidate.b.id, flip(candidate.b.state)]);
  }
  // fromEntries 保证 __proto__ 等特殊 ID 落为自有数据属性
  const violationLocks = Object.fromEntries([
    ...Object.entries(locks),
    ...extra,
  ]);
  const violation = solveWorkspace(workspace, violationLocks);
  if (violation.kind === 'unsat') {
    return { kind: 'redundant' };
  }
  return { kind: 'tightens', plan: tightened, counterexample: violation };
}
