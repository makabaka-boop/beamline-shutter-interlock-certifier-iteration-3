import type { ShutterState, Workspace } from '../core/types';
import type { CandidatePrecheck, CandidateRule } from '../core/candidate';
import { withCandidateRule } from '../core/candidate';
import { PathView } from './SolutionPanel';

export interface CandidateCheckSnapshot {
  candidate: CandidateRule;
  result: CandidatePrecheck;
  /** 预检时的规则/锁定版本；与当前 specRev 不同即过期 */
  specRev: number;
  /** 预检时的候选原文；草稿被编辑后与之不同即过期 */
  text: string;
}

interface Props {
  workspace: Workspace;
  locks: Record<string, ShutterState>;
  text: string;
  onTextChange: (text: string) => void;
  check: CandidateCheckSnapshot | null;
  /** 规则/锁定/导入变化（specRev）或草稿被编辑 → 预检过期 */
  stale: boolean;
  onPrecheck: () => void;
  onConfirm: () => void;
}

/** 候选预检方案小表：ID / 状态 / 原锁定，证明方案逐把遵守原锁定。 */
function MiniPlanTable({
  orderedIds,
  assignment,
  locks,
  testid,
}: {
  orderedIds: string[];
  assignment: Record<string, ShutterState>;
  locks: Record<string, ShutterState>;
  testid: string;
}) {
  return (
    <table className="plan-table" data-testid={testid}>
      <thead>
        <tr>
          <th>快门 ID</th>
          <th>状态</th>
          <th>原锁定</th>
        </tr>
      </thead>
      <tbody>
        {orderedIds.map((id) => {
          const state = assignment[id];
          const locked = Object.prototype.hasOwnProperty.call(locks, id);
          return (
            <tr key={id} data-testid={`${testid}-row-${id}`}>
              <td className="mono">{id}</td>
              <td className={`plan-state ${state.toLowerCase()}`}>{state}</td>
              <td className="mono">{locked ? locks[id] : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LiteralText({ lit }: { lit: { id: string; state: ShutterState } }) {
  return (
    <span className="mono">
      {lit.id}={lit.state}
    </span>
  );
}

export function CandidatePanel({
  workspace,
  locks,
  text,
  onTextChange,
  check,
  stale,
  onPrecheck,
  onConfirm,
}: Props) {
  const result = stale ? null : check?.result ?? null;
  const candidate = check?.candidate ?? null;
  // 候选冲突见证中的规则边可能引用候选规则序号：用含候选的工作区视图渲染
  const witnessWorkspace =
    candidate && result?.kind === 'candidate-conflict'
      ? withCandidateRule(workspace, candidate).workspace
      : workspace;

  const canConfirm =
    result !== null &&
    (result.kind === 'tightening' || result.kind === 'redundant');

  return (
    <section className="panel panel-wide" data-testid="candidate-panel">
      <h2>
        新增规则预检
        <span className="rule-semantics">
          复用导入解析与 2-SAT 语义；预检不修改工作区，确认后才把规则追加到末尾
        </span>
      </h2>
      <textarea
        data-testid="candidate-text"
        className="import-text"
        rows={2}
        spellCheck={false}
        value={text}
        placeholder="S1 OPEN OR S2 CLOSED"
        onChange={(e) => onTextChange(e.target.value)}
      />
      <div className="import-actions">
        <button
          type="button"
          className="primary"
          data-testid="candidate-precheck"
          onClick={onPrecheck}
        >
          预检候选规则
        </button>
        <button
          type="button"
          data-testid="candidate-confirm"
          onClick={onConfirm}
          disabled={!canConfirm || stale}
        >
          确认新增该规则
        </button>
        <span className="muted">
          确认只允许基于尚未变化的工作区；导入或编辑使预检过期后须重新预检。
        </span>
      </div>

      {check && stale && (
        <div className="warning" data-testid="candidate-stale">
          ⚠ 工作区规则、锁定或候选草稿已变化，此预检已过期，不能确认；请重新预检。
        </div>
      )}

      {result && result.kind === 'baseline-conflict' && (
        <div className="candidate-result result-unsat" data-testid="candidate-baseline-conflict">
          <h3>✗ 原工作区已冲突：当前规则与锁定本就无解（与候选无关）</h3>
          <p className="muted">
            下列冲突闭环完全由现有规则与锁定蕴含，候选规则尚未加入、未被归咎。
            请先按原认证流程处理既有冲突（解除锁定或修改规则后重新导入），再考虑新增规则。
          </p>
          <PathView
            title={`既有冲突路径一：${result.baseline.witness.id}=OPEN → ${result.baseline.witness.id}=CLOSED`}
            steps={result.baseline.witness.openToClosed}
            workspace={workspace}
            testid="candidate-baseline-path-open-to-closed"
          />
          <PathView
            title={`既有冲突路径二：${result.baseline.witness.id}=CLOSED → ${result.baseline.witness.id}=OPEN`}
            steps={result.baseline.witness.closedToOpen}
            workspace={workspace}
            testid="candidate-baseline-path-closed-to-open"
          />
        </div>
      )}

      {result && result.kind === 'candidate-conflict' && candidate && (
        <div className="candidate-result result-unsat" data-testid="candidate-conflict">
          <h3>✗ 候选导致冲突：当前锁定配置在加入候选后无解</h3>
          <p className="muted">
            当前规则与锁定本有可行方案（见下表）；加入候选「
            <span className="mono">{candidate.text}</span>
            」后才产生矛盾。下列闭环中的「候选规则」边即来自该候选，可逐条复核。
          </p>
          <PathView
            title={`候选冲突路径一：${result.withCandidate.witness.id}=OPEN → ${result.withCandidate.witness.id}=CLOSED`}
            steps={result.withCandidate.witness.openToClosed}
            workspace={witnessWorkspace}
            testid="candidate-conflict-path-open-to-closed"
          />
          <PathView
            title={`候选冲突路径二：${result.withCandidate.witness.id}=CLOSED → ${result.withCandidate.witness.id}=OPEN`}
            steps={result.withCandidate.witness.closedToOpen}
            workspace={witnessWorkspace}
            testid="candidate-conflict-path-closed-to-open"
          />
          <p className="muted">原锁定下本可执行的一份方案（证明冲突由候选引入）：</p>
          <MiniPlanTable
            orderedIds={result.baselinePlan.orderedIds}
            assignment={result.baselinePlan.assignment}
            locks={locks}
            testid="candidate-conflict-baseline-plan"
          />
        </div>
      )}

      {result && result.kind === 'redundant' && candidate && (
        <div className="candidate-result" data-testid="candidate-redundant">
          <h3 style={{ color: 'var(--ok)' }}>
            ✓ 候选冗余：当前规则与锁定已蕴含该规则
          </h3>
          <p className="muted">
            所有当前可行方案都已满足「<span className="mono">{candidate.text}</span>
            」，新增它不会排除任何快门组合。仍可确认新增（仅作记录），也可不新增。
            当前字典序最小方案：
          </p>
          <MiniPlanTable
            orderedIds={result.baselinePlan.orderedIds}
            assignment={result.baselinePlan.assignment}
            locks={locks}
            testid="candidate-redundant-plan"
          />
        </div>
      )}

      {result && result.kind === 'tightening' && candidate && (
        <div className="candidate-result" data-testid="candidate-tightening">
          <h3 style={{ color: 'var(--warn)' }}>
            ⚡ 候选有效收紧：会排除至少一种原本合法的快门组合
          </h3>
          <p className="muted">
            被排除的组合即候选两个文字同时不成立：
            <LiteralText lit={{ id: candidate.a.id, state: oppositeOf(candidate.a.state) }} />
            {' 且 '}
            <LiteralText lit={{ id: candidate.b.id, state: oppositeOf(candidate.b.state) }} />
            。下方两份方案都遵守全部原锁定，可对照复核。
          </p>
          <h4>满足候选的规范方案（加入候选后的 CLOSED 优先字典序最小完整方案）</h4>
          <MiniPlanTable
            orderedIds={result.satisfying.orderedIds}
            assignment={result.satisfying.assignment}
            locks={locks}
            testid="candidate-satisfying-plan"
          />
          <h4>违反候选的可复核见证（原规则 + 原锁定下的字典序最小完整方案）</h4>
          <MiniPlanTable
            orderedIds={result.violating.orderedIds}
            assignment={result.violating.assignment}
            locks={locks}
            testid="candidate-violating-plan"
          />
        </div>
      )}
    </section>
  );
}

function oppositeOf(s: ShutterState): ShutterState {
  return s === 'OPEN' ? 'CLOSED' : 'OPEN';
}
