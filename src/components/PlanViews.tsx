import type {
  Change,
  EdgeReason,
  ImplicationStep,
  Rule,
  ShutterState,
  Workspace,
} from '../core/types';

/**
 * 边依据的展示标签。candidate 为待新增的候选规则：候选预检的冲突见证
 * 在「原规则 + 候选」的扩展图上求得，ruleIndex 等于原规则数时指回候选。
 */
export function reasonLabel(
  reason: EdgeReason,
  workspace: Workspace,
  candidate?: Rule | null,
): { tag: string; detail: string } {
  if (reason.kind === 'rule') {
    if (reason.ruleIndex < workspace.rules.length) {
      return {
        tag: `规则 #${reason.ruleIndex}`,
        detail: workspace.rules[reason.ruleIndex].text,
      };
    }
    if (candidate && reason.ruleIndex === candidate.index) {
      return { tag: '候选规则', detail: candidate.text };
    }
    return { tag: `规则 #${reason.ruleIndex}`, detail: '（不在当前工作区）' };
  }
  if (reason.kind === 'lock') {
    return { tag: '锁定', detail: `操作员锁定 ${reason.id} = ${reason.state}` };
  }
  return { tag: '试设', detail: `贪心试设 ${reason.state}` };
}

export function PathView({
  title,
  steps,
  workspace,
  candidate,
  testid,
}: {
  title: string;
  steps: ImplicationStep[];
  workspace: Workspace;
  candidate?: Rule | null;
  testid: string;
}) {
  return (
    <div className="witness-path" data-testid={testid}>
      <div className="path-title">{title}</div>
      {steps.length === 0 ? (
        <div className="path-step">（空路径：两端为同一文字）</div>
      ) : (
        <ol>
          {steps.map((s, i) => {
            const why = reasonLabel(s.reason, workspace, candidate);
            return (
              <li key={i} className="path-step" data-testid={`${testid}-step-${i}`}>
                <span className="mono">
                  {s.from.id}={s.from.state}
                </span>
                <span className="arrow"> ⇒ </span>
                <span className="mono">
                  {s.to.id}={s.to.state}
                </span>
                <span className="reason">
                  依据 [{why.tag}] {why.detail}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** 完整方案表：方案状态、当前状态与改动，按 UTF-8 字节序逐行列出。 */
export function PlanTable({
  orderedIds,
  assignment,
  changes,
  testid,
  rowTestId,
}: {
  orderedIds: string[];
  assignment: Record<string, ShutterState>;
  changes: Change[];
  testid: string;
  rowTestId: (id: string) => string;
}) {
  return (
    <table className="plan-table" data-testid={testid}>
      <thead>
        <tr>
          <th>快门 ID</th>
          <th>方案状态</th>
          <th>当前状态</th>
          <th>改动</th>
        </tr>
      </thead>
      <tbody>
        {orderedIds.map((id) => {
          const to = assignment[id];
          const from = changes.find((c) => c.id === id)?.from ?? to;
          const isChange = changes.some((c) => c.id === id);
          return (
            <tr key={id} data-testid={rowTestId(id)} className={isChange ? 'row-change' : ''}>
              <td className="mono">{id}</td>
              <td className={`plan-state ${to.toLowerCase()}`}>{to}</td>
              <td className="mono">{from}</td>
              <td>{isChange ? `${from} → ${to}` : '不变'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
