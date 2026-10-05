import type {
  Change,
  LockRepair,
  ShutterState,
  SolveOutcome,
  Workspace,
} from '../core/types';
import { PathView, PlanTable } from './PlanViews';

interface Props {
  preview: {
    outcome: SolveOutcome;
    repair: LockRepair | null;
    specRev: number;
  } | null;
  stale: boolean;
  changes: Change[];
  /** 修复建议候选方案相对当前快门表的改动 */
  repairChanges: Change[];
  locks: Record<string, ShutterState>;
  workspace: Workspace;
  adopted: boolean;
  onConfirmRepair: () => void;
}

/** 无解时的锁定修复建议区：最少撤销清单 + 撤销后的候选方案 + 确认修复。 */
function RepairPanel({
  repair,
  repairChanges,
  locks,
  onConfirmRepair,
}: {
  repair: LockRepair;
  repairChanges: Change[];
  locks: Record<string, ShutterState>;
  onConfirmRepair: () => void;
}) {
  if (repair.kind === 'rules-conflict') {
    return (
      <div className="repair-panel repair-conflict" data-testid="repair-rules-conflict">
        <h4>规则自身冲突，不提供锁定修复建议</h4>
        <p className="muted">
          即使撤销全部临时锁定，联锁规则仍然无解。问题出在规则本身而非值班锁定，
          请修改规则后重新导入；不修改规则、不翻转锁定值、不套用旧快门表。
        </p>
      </div>
    );
  }
  if (repair.kind === 'too-many-locks') {
    return (
      <div className="repair-panel" data-testid="repair-too-many-locks">
        <h4>锁定过多，未计算精确修复建议</h4>
        <p className="muted">
          当前锁定 {repair.count} 个，超过 8 个上限，不做精确最少撤销枚举。
          请手动减少锁定后重新认证。
        </p>
      </div>
    );
  }
  return (
    <div className="repair-panel" data-testid="repair-suggestion">
      <h4>
        锁定修复建议：最少撤销 {repair.remove.length} 个临时锁定即可恢复可行方案
      </h4>
      <p className="muted">
        规则与快门表保持不变；并列最少撤销时按快门 ID 的 UTF-8 字节序取舍。
        需撤销的锁定：
      </p>
      <ul className="repair-remove-list">
        {repair.remove.map((id) => (
          <li key={id} data-testid={`repair-remove-${id}`}>
            <span className="mono">{id}</span>
            <span className="muted">（当前锁定为 {locks[id]}）</span>
          </li>
        ))}
      </ul>
      <p className="muted">
        撤销后由原 2-SAT 求解器给出的字典序最小完整方案（候选，确认前不生效）：
      </p>
      <PlanTable
        orderedIds={repair.outcome.orderedIds}
        assignment={repair.outcome.assignment}
        changes={repairChanges}
        testid="repair-plan-table"
        rowTestId={(id) => `repair-plan-row-${id}`}
      />
      <div className="repair-actions">
        <button
          type="button"
          className="primary"
          data-testid="confirm-repair"
          onClick={onConfirmRepair}
        >
          确认修复：一次性撤销所列 {repair.remove.length} 个锁定并重新认证
        </button>
      </div>
    </div>
  );
}

export function SolutionPanel({
  preview,
  stale,
  changes,
  repairChanges,
  locks,
  workspace,
  adopted,
  onConfirmRepair,
}: Props) {
  if (!preview) {
    return (
      <p className="muted" data-testid="no-result">
        尚未运行认证。锁定任意快门（可选）后点击「运行认证」。
      </p>
    );
  }
  if (stale) {
    return (
      <div className="result-faded" data-testid="stale-result">
        <p className="muted">（旧结果仅供参考，已被标记为失效。）</p>
      </div>
    );
  }

  const { outcome, repair } = preview;

  if (outcome.kind === 'unsat') {
    const w = outcome.witness;
    return (
      <div className="result-unsat" data-testid="result-unsat">
        <h3>✗ 无可行方案：快门「{w.id}」的 OPEN 与 CLOSED 落在同一强连通分量</h3>
        <p className="muted">
          该快门 ID（{w.id}）是所有“正反文字同 SCC”快门中按 UTF-8 字节序最小者。
          两条蕴含路径构成闭环，每一步均可指回原规则，逐条复核如下：
        </p>
        <PathView
          title={`路径一：假设 ${w.id} 为 OPEN，蕴含它必须 CLOSED（${w.id}=OPEN → ${w.id}=CLOSED）`}
          steps={w.openToClosed}
          workspace={workspace}
          testid="path-open-to-closed"
        />
        <PathView
          title={`路径二：假设 ${w.id} 为 CLOSED，蕴含它必须 OPEN（${w.id}=CLOSED → ${w.id}=OPEN）`}
          steps={w.closedToOpen}
          workspace={workspace}
          testid="path-closed-to-open"
        />
        {repair && (
          <RepairPanel
            repair={repair}
            repairChanges={repairChanges}
            locks={locks}
            onConfirmRepair={onConfirmRepair}
          />
        )}
        <p className="muted">
          请修改规则或解除锁定后重新认证；当前锁定组合下不提供执行稿。
        </p>
      </div>
    );
  }

  return (
    <div className="result-sat" data-testid="result-sat">
      <h3>✓ 存在可行方案（按 ID 的 UTF-8 字节序、CLOSED 优先的字典序最小完整方案）</h3>
      <PlanTable
        orderedIds={outcome.orderedIds}
        assignment={outcome.assignment}
        changes={changes}
        testid="plan-table"
        rowTestId={(id) => `plan-row-${id}`}
      />
      <div className="changes-summary" data-testid="changes-summary">
        {changes.length === 0 ? (
          <span>当前快门表与最小方案完全一致，无需改动。</span>
        ) : (
          <span>
            共 {changes.length} 处改动：
            {changes.map((c) => (
              <span key={c.id} className="change-chip" data-testid={`change-${c.id}`}>
                {c.id}：{c.from}→{c.to}
              </span>
            ))}
          </span>
        )}
      </div>
      {adopted && (
        <div className="muted">方案已采纳到快门表。</div>
      )}
    </div>
  );
}
