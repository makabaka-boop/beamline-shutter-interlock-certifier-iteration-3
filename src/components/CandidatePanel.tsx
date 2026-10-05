import { useState } from 'react';
import type {
  CandidatePrecheck,
  CandidateRule,
  ShutterState,
  Workspace,
} from '../core/types';
import { computeChanges } from '../core/sat';
import { PathView, PlanTable } from './PlanViews';

/**
 * 一次候选规则预检的记录：候选文本、结论与所基于的工作区版本。
 * specRev 与当前不一致即过期，过期预检不能确认新增。
 */
export interface PrecheckRecord {
  candidate: CandidateRule;
  result: CandidatePrecheck;
  specRev: number;
}

interface Props {
  workspace: Workspace;
  locks: Record<string, ShutterState>;
  table: Record<string, ShutterState>;
  specRev: number;
  precheck: PrecheckRecord | null;
  /** 返回校验错误列表；成功时错误为空且预检记录已更新 */
  onPrecheck: (text: string) => string[];
  onConfirmAdd: () => void;
}

/**
 * 新增二元联锁规则的候选预检面板。预检本身只读：不改动规则、锁定、
 * 认证结论或导出；确认新增只在预检未过期、且结论为「有效收紧」或
 * 「冗余」时可用（两种冲突结论不提供确认入口）。
 */
export function CandidatePanel({
  workspace,
  locks,
  table,
  specRev,
  precheck,
  onPrecheck,
  onConfirmAdd,
}: Props) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const runPrecheck = () => {
    setErrors(onPrecheck(text));
  };

  const stale = precheck !== null && precheck.specRev !== specRev;
  const textChanged =
    precheck !== null && text.trim() !== precheck.candidate.text;
  const confirmableKind =
    precheck !== null &&
    (precheck.result.kind === 'tightens' ||
      precheck.result.kind === 'redundant');
  const canConfirm = confirmableKind && !stale && !textChanged;

  // 见证路径中「候选规则」标签所需的规则对象（序号 = 预检时的原规则数，
  // 与 precheckCandidateRule 构图时使用的序号一致）
  const candidateAsRule =
    precheck !== null
      ? {
          index: workspace.rules.length,
          a: precheck.candidate.a,
          b: precheck.candidate.b,
          text: precheck.candidate.text,
        }
      : null;

  return (
    <div className="candidate-panel" data-testid="candidate-panel">
      <h3>新增规则预检</h3>
      <p className="muted">
        输入一条候选二元规则，预检它会排除哪些当前合法的快门组合、是否令当前锁定配置无解。
        预检不改动规则、锁定、认证结论或导出；确认新增只在预检未过期时可用。
      </p>
      <div className="candidate-input-row">
        <input
          type="text"
          data-testid="candidate-text"
          spellCheck={false}
          value={text}
          placeholder="ID OPEN|CLOSED [OR] ID OPEN|CLOSED"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" data-testid="precheck-btn" onClick={runPrecheck}>
          预检候选规则
        </button>
      </div>
      {errors.length > 0 && (
        <div className="error-box" data-testid="candidate-errors">
          <strong>候选规则未通过校验，工作区保持不变：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {precheck && stale && (
        <div className="warning" data-testid="precheck-stale">
          ⚠ 规则或锁定已变化，此预检结果已过期，不能确认新增；请重新预检。
        </div>
      )}

      {precheck && !stale && (
        <div className="precheck-result" data-testid="precheck-result">
          {precheck.result.kind === 'base-conflict' && (
            <div className="precheck-base-conflict" data-testid="precheck-base-conflict">
              <h4>✗ 原工作区已冲突</h4>
              <p className="muted">
                当前规则与锁定本就无解，候选预检不适用。以下冲突闭环完全来自现有规则与锁定，
                与候选规则「{precheck.candidate.text}」无关；请先解决现有冲突再评估新增。
              </p>
              <PathView
                title={`路径一：假设 ${precheck.result.witness.id} 为 OPEN，蕴含它必须 CLOSED`}
                steps={precheck.result.witness.openToClosed}
                workspace={workspace}
                testid="precheck-path-open-to-closed"
              />
              <PathView
                title={`路径二：假设 ${precheck.result.witness.id} 为 CLOSED，蕴含它必须 OPEN`}
                steps={precheck.result.witness.closedToOpen}
                workspace={workspace}
                testid="precheck-path-closed-to-open"
              />
            </div>
          )}

          {precheck.result.kind === 'candidate-conflict' && (
            <div
              className="precheck-candidate-conflict"
              data-testid="precheck-candidate-conflict"
            >
              <h4>✗ 候选导致冲突</h4>
              <p className="muted">
                当前配置可行，但加入候选「{precheck.candidate.text}」后无解。
                闭环中标注「候选规则」的步骤来自待新增规则；不提供确认新增。
              </p>
              <PathView
                title={`路径一：假设 ${precheck.result.witness.id} 为 OPEN，蕴含它必须 CLOSED`}
                steps={precheck.result.witness.openToClosed}
                workspace={workspace}
                candidate={candidateAsRule}
                testid="precheck-path-open-to-closed"
              />
              <PathView
                title={`路径二：假设 ${precheck.result.witness.id} 为 CLOSED，蕴含它必须 OPEN`}
                steps={precheck.result.witness.closedToOpen}
                workspace={workspace}
                candidate={candidateAsRule}
                testid="precheck-path-closed-to-open"
              />
            </div>
          )}

          {precheck.result.kind === 'redundant' && (
            <div className="precheck-redundant" data-testid="precheck-redundant">
              <h4>○ 候选冗余</h4>
              <p className="muted">
                当前所有可行方案（遵守全部锁定）本就满足候选「{precheck.candidate.text}
                」，新增不会排除任何快门组合；确认后仅作显式登记。
              </p>
            </div>
          )}

          {precheck.result.kind === 'tightens' && (
            <div className="precheck-tightens" data-testid="precheck-tightens">
              <h4>✓ 候选有效收紧</h4>
              <p className="muted">
                新增后仍可行，但会排除一部分当前合法的快门组合。以下两份方案均遵守当前锁定。
              </p>
              <h5>满足候选的规范方案（加入候选后的字典序最小完整方案）</h5>
              <PlanTable
                orderedIds={precheck.result.plan.orderedIds}
                assignment={precheck.result.plan.assignment}
                changes={computeChanges(
                  precheck.result.plan.orderedIds,
                  precheck.result.plan.assignment,
                  table,
                )}
                testid="precheck-plan-table"
                rowTestId={(id) => `precheck-plan-row-${id}`}
              />
              <h5>违反候选的可复核见证（当前合法、新增后被排除）</h5>
              <p className="muted">
                该组合满足当前全部 {workspace.rules.length} 条规则与全部{' '}
                {Object.keys(locks).length} 个锁定，但候选的两个文字均不成立（
                {precheck.candidate.a.id} ≠ {precheck.candidate.a.state} 且{' '}
                {precheck.candidate.b.id} ≠ {precheck.candidate.b.state}
                ），逐行可复核。
              </p>
              <PlanTable
                orderedIds={precheck.result.counterexample.orderedIds}
                assignment={precheck.result.counterexample.assignment}
                changes={computeChanges(
                  precheck.result.counterexample.orderedIds,
                  precheck.result.counterexample.assignment,
                  table,
                )}
                testid="precheck-counterexample-table"
                rowTestId={(id) => `precheck-counterexample-row-${id}`}
              />
            </div>
          )}

          {textChanged && (
            <div className="warning" data-testid="precheck-text-changed">
              ⚠ 候选文本已修改，与预检结果不一致，请重新预检。
            </div>
          )}

          {confirmableKind && (
            <div className="precheck-actions">
              <button
                type="button"
                className="primary"
                data-testid="confirm-add-rule"
                disabled={!canConfirm}
                onClick={onConfirmAdd}
              >
                确认新增：将候选并入为规则 #{workspace.rules.length}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
