import { useMemo, useState } from 'react';
import type { LockRepair, ShutterState, SolveOutcome, Workspace } from './core/types';
import { parseCandidateRule, parseWorkspace } from './core/parser';
import { suggestLockRepair } from './core/repair';
import { computeChanges, solveWorkspace } from './core/sat';
import {
  precheckCandidate,
  withCandidateRule,
  type CandidateRule,
} from './core/candidate';
import { sortByUtf8 } from './core/utf8';
import { downloadText, serializeTable } from './lib/export';
import { SAMPLE_WORKSPACE } from './lib/sample';
import { cycleLockState, initialTable, toggleLock } from './lib/state';
import { ImportPanel } from './components/ImportPanel';
import { ShutterTable } from './components/ShutterTable';
import { RulesPanel } from './components/RulesPanel';
import { SolutionPanel } from './components/SolutionPanel';
import { CandidatePanel, type CandidateCheckSnapshot } from './components/CandidatePanel';

interface Preview {
  outcome: SolveOutcome;
  /** 无解时的锁定修复建议；可行时为 null。与 outcome 同属一次认证，随 specRev 一起失效 */
  repair: LockRepair | null;
  /** 认证时的规则版本；与当前 specRev 不同则已失效 */
  specRev: number;
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [table, setTable] = useState<Record<string, ShutterState>>({});
  const [locks, setLocks] = useState<Record<string, ShutterState>>({});
  /** 规则或锁定每次变化自增：使旧预览 / 候选预检立即失效 */
  const [specRev, setSpecRev] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [adopted, setAdopted] = useState(false);
  const [candidateText, setCandidateText] = useState('');
  const [candidateCheck, setCandidateCheck] = useState<CandidateCheckSnapshot | null>(null);
  const [candidateErrors, setCandidateErrors] = useState<string[]>([]);

  const orderedIds = useMemo(
    () => (workspace ? sortByUtf8(workspace.ids, (id) => id) : []),
    [workspace],
  );

  const previewStale = preview !== null && preview.specRev !== specRev;
  /**
   * 候选预检仅在以下条件同时成立时有效：规则/锁定版本未变（specRev），
   * 且候选草稿未被再次编辑（text）。任何导入、规则确认、锁定编辑或草稿修改
   * 都会立即使旧预检过期，过期预检不可确认。
   */
  const candidateStale =
    candidateCheck !== null &&
    (candidateCheck.specRev !== specRev || candidateCheck.text !== candidateText);

  const handleImport = (text: string): string[] => {
    const result = parseWorkspace(text);
    if (!result.ok || !result.workspace) {
      // 拒绝整份导入，保留当前工作区
      return result.errors;
    }
    setWorkspace(result.workspace);
    setTable(initialTable(result.workspace.ids));
    setLocks({});
    setPreview(null);
    setAdopted(false);
    setCandidateCheck(null);
    setCandidateErrors([]);
    setCandidateText('');
    setSpecRev((r) => r + 1);
    return [];
  };

  const handleToggleLock = (id: string) => {
    // 未锁定时锁定到该快门当前表值，随后可用按钮切换锁定状态
    setLocks((prev) => toggleLock(prev, id, table[id]));
    setSpecRev((r) => r + 1);
  };

  const handleCycleLockState = (id: string) => {
    setLocks((prev) => cycleLockState(prev, id));
    setSpecRev((r) => r + 1);
  };

  const handleSetTable = (id: string, state: ShutterState) => {
    setTable((prev) => ({ ...prev, [id]: state }));
    setAdopted(false);
  };

  /** 对给定锁定集合运行一次认证，并把结果（含无解时的修复建议）写入预览 */
  const runCertify = (
    ws: Workspace,
    lk: Record<string, ShutterState>,
    rev: number,
  ) => {
    const outcome = solveWorkspace(ws, lk);
    const repair = outcome.kind === 'unsat' ? suggestLockRepair(ws, lk) : null;
    setPreview({ outcome, repair, specRev: rev });
    setAdopted(false);
  };

  const handleRun = () => {
    if (!workspace) return;
    runCertify(workspace, locks, specRev);
  };

  /**
   * 确认修复：只一次性撤销建议所列的锁定（规则、快门表与其余锁定一律不动），
   * 随后用新的锁定集合重新认证。建议已过期（规则或锁定期间被改动）时拒绝执行。
   */
  const handleConfirmRepair = () => {
    if (!workspace || !preview || previewStale) return;
    if (preview.outcome.kind !== 'unsat' || preview.repair?.kind !== 'suggestion') {
      return;
    }
    const removeSet = new Set(preview.repair.remove);
    const nextLocks = Object.fromEntries(
      Object.entries(locks).filter(([id]) => !removeSet.has(id)),
    );
    const nextRev = specRev + 1;
    setLocks(nextLocks);
    setSpecRev(nextRev);
    runCertify(workspace, nextLocks, nextRev);
  };

  const handleAdopt = () => {
    if (!preview || previewStale || preview.outcome.kind !== 'sat') return;
    setTable({ ...preview.outcome.assignment });
    setAdopted(true);
  };

  const handleDownload = () => {
    if (!workspace || !adopted || previewStale) return;
    downloadText('shutter-table.txt', serializeTable(workspace, table));
  };

  /**
   * 候选规则预检：复用导入解析（parseCandidateRule 与导入共用 parseRuleLine）
   * 与 2-SAT 语义，在原工作区的临时视图上裁决。全程不改规则、锁定、快门表、
   * 认证结论与导出。
   */
  const handleCandidatePrecheck = () => {
    if (!workspace) return;
    const parsed = parseCandidateRule(candidateText, workspace);
    if (!parsed.ok || !parsed.rule) {
      setCandidateErrors(parsed.errors);
      setCandidateCheck(null);
      return;
    }
    const candidate: CandidateRule = parsed.rule;
    const result = precheckCandidate(workspace, locks, candidate);
    setCandidateErrors([]);
    setCandidateCheck({
      candidate,
      result,
      specRev,
      text: candidateText,
    });
  };

  const handleCandidateTextChange = (next: string) => {
    setCandidateText(next);
    // 草稿一旦改动，旧预检立即过期（candidateStale 经 text 比对生效）
  };

  /**
   * 确认新增候选：只允许基于尚未变化的工作区——预检过期（导入、锁定编辑、
   * 规则变化或草稿被改）时立即拒绝。确认把候选追加为末条规则，规则序号与
   * 预检时的临时视图一致；认证结论不自动重算（沿用既有「规则变化须重新认证」
   * 语义），采纳/导出状态清除。
   */
  const handleConfirmCandidate = () => {
    if (!workspace || !candidateCheck || candidateStale) return;
    const { result, candidate } = candidateCheck;
    if (result.kind !== 'tightening' && result.kind !== 'redundant') return;
    const { workspace: augmented } = withCandidateRule(workspace, candidate);
    setWorkspace(augmented);
    setCandidateCheck(null);
    setCandidateErrors([]);
    setCandidateText('');
    setPreview(null);
    setAdopted(false);
    setSpecRev((r) => r + 1);
  };

  const changes =
    preview && !previewStale && preview.outcome.kind === 'sat'
      ? computeChanges(preview.outcome.orderedIds, preview.outcome.assignment, table)
      : [];

  /** 修复建议候选方案相对当前快门表的改动（仅供展示，确认前不生效） */
  const repairChanges =
    preview && !previewStale && preview.repair?.kind === 'suggestion'
      ? computeChanges(
          preview.repair.outcome.orderedIds,
          preview.repair.outcome.assignment,
          table,
        )
      : [];

  return (
    <div className="app">
      <header className="app-header">
        <h1>束线快门联锁认证工作台</h1>
        <p className="subtitle">
          离线 2-SAT 蕴含图裁决 · CLOSED 优先字典序最小方案 · 冲突闭环逐条复核
        </p>
      </header>

      {!workspace && (
        <section className="empty-hint" data-testid="empty-state">
          <p>工作区为空。请在下方粘贴或载入示例导入文本，校验通过后即可开始调试。</p>
        </section>
      )}

      <ImportPanel onImport={handleImport} onLoadSample={() => SAMPLE_WORKSPACE} />

      {workspace && (
        <main className="workspace-grid">
          <section className="panel" data-testid="shutter-panel">
            <h2>
              快门表 <span className="count">（{workspace.ids.length}）</span>
            </h2>
            <ShutterTable
              ids={orderedIds}
              table={table}
              locks={locks}
              onSetTable={handleSetTable}
              onToggleLock={handleToggleLock}
              onCycleLockState={handleCycleLockState}
            />
          </section>

          <section className="panel" data-testid="rules-panel">
            <h2>
              联锁规则 <span className="count">（{workspace.rules.length}）</span>
              <span className="rule-semantics">每条规则：两个文字至少一个成立</span>
            </h2>
            <RulesPanel workspace={workspace} />
          </section>

          <CandidatePanel
            workspace={workspace}
            locks={locks}
            text={candidateText}
            onTextChange={handleCandidateTextChange}
            check={candidateCheck}
            stale={candidateStale}
            onPrecheck={handleCandidatePrecheck}
            onConfirm={handleConfirmCandidate}
          />
          {candidateErrors.length > 0 && (
            <div className="error-box" data-testid="candidate-errors">
              <strong>候选规则被拒绝，工作区未改动：</strong>
              <ul>
                {candidateErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <section className="panel panel-wide" data-testid="certify-panel">
            <h2>认证</h2>
            <div className="certify-controls">
              <button
                type="button"
                className="primary"
                data-testid="run-certify"
                onClick={handleRun}
              >
                运行认证
              </button>
              <button
                type="button"
                data-testid="adopt-plan"
                onClick={handleAdopt}
                disabled={
                  !preview ||
                  previewStale ||
                  preview.outcome.kind !== 'sat'
                }
              >
                采纳方案
              </button>
              <button
                type="button"
                data-testid="download-plan"
                onClick={handleDownload}
                disabled={!adopted || previewStale}
              >
                下载采纳稿
              </button>
              <span className="lock-summary">
                已锁定 {Object.keys(locks).length} 个快门
                {Object.keys(locks).length > 0 &&
                  `：${sortByUtf8(Object.keys(locks), (id) => id)
                    .map((id) => `${id}=${locks[id]}`)
                    .join('，')}`}
              </span>
            </div>
            {preview && previewStale && (
              <div className="warning" data-testid="stale-warning">
                ⚠ 规则或锁定已变化，此预览已失效，请重新运行认证。
              </div>
            )}
            {adopted && !previewStale && (
              <div className="ok-banner" data-testid="adopted-banner">
                ✓ 方案已采纳，快门表与认证结果一致，可下载执行稿。
              </div>
            )}
            <SolutionPanel
              preview={preview}
              stale={previewStale}
              changes={changes}
              repairChanges={repairChanges}
              locks={locks}
              workspace={workspace}
              adopted={adopted}
              onConfirmRepair={handleConfirmRepair}
            />
          </section>
        </main>
      )}

      <footer className="app-footer">
        纯前端离线工作台 · TypeScript + React + Vite · 计算全部在浏览器内完成
      </footer>
    </div>
  );
}
