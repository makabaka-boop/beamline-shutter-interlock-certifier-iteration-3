import { describe, expect, it } from 'vitest';
import type { ShutterState, Workspace } from './core/types';
import { parseCandidateRule, parseWorkspace } from './core/parser';
import { precheckCandidate, withCandidateRule } from './core/candidate';
import { solveWorkspace } from './core/sat';
import { initialTable } from './lib/state';

/**
 * 候选预检 ↔ 确认的隔离状态机测试。
 *
 * App 是纯函数接线（handler 只组合 core/lib 的纯函数 + setState），
 * 这里以最小 reducer 复刻 App 中与候选预检相关的状态转移：
 * specRev 在「导入 / 锁定编辑 / 确认新增」时自增；预检快照记录当时的
 * specRev 与草稿文本；确认仅在两者都未变化且结论可新增时生效。
 * 与 src/App.tsx 的判定式保持逐字一致：
 *   stale = check.specRev !== specRev || check.text !== candidateText
 */

interface AppState {
  workspace: Workspace;
  table: Record<string, ShutterState>;
  locks: Record<string, ShutterState>;
  specRev: number;
  candidateText: string;
  check:
    | {
        specRev: number;
        text: string;
        kind: ReturnType<typeof precheckCandidate>['kind'];
      }
    | null;
  previewRev: number | null;
  adopted: boolean;
}

function importState(text: string): AppState {
  const r = parseWorkspace(text);
  if (!r.ok || !r.workspace) throw new Error(r.errors.join('\n'));
  return {
    workspace: r.workspace,
    table: initialTable(r.workspace.ids),
    locks: {},
    specRev: 1,
    candidateText: '',
    check: null,
    previewRev: null,
    adopted: false,
  };
}

function runPrecheck(s: AppState): { state: AppState; errors: string[] } {
  const parsed = parseCandidateRule(s.candidateText, s.workspace);
  if (!parsed.ok || !parsed.rule) {
    return { state: { ...s, check: null }, errors: parsed.errors };
  }
  const result = precheckCandidate(s.workspace, s.locks, parsed.rule);
  return {
    state: { ...s, check: { specRev: s.specRev, text: s.candidateText, kind: result.kind } },
    errors: [],
  };
}

/** 与 App.handleCandidatePrecheck 相同的过期判定 */
function isStale(s: AppState): boolean {
  return s.check !== null && (s.check.specRev !== s.specRev || s.check.text !== s.candidateText);
}

function setLock(s: AppState, id: string, state: ShutterState): AppState {
  // 复刻 handleToggleLock/handleCycleLockState：锁定变化即 bump specRev
  return { ...s, locks: { ...s.locks, [id]: state }, specRev: s.specRev + 1 };
}

function setDraft(s: AppState, text: string): AppState {
  return { ...s, candidateText: text };
}

function confirmCandidate(s: AppState): AppState {
  if (!s.check || isStale(s)) return s; // 过期立即拒绝
  if (s.check.kind !== 'tightening' && s.check.kind !== 'redundant') return s;
  // 重新解析 + 追加（App 从快照取 candidate；此处用草稿重新解析以核对等价性）
  const parsed = parseCandidateRule(s.candidateText, s.workspace);
  if (!parsed.ok || !parsed.rule) return s;
  const { workspace } = withCandidateRule(s.workspace, parsed.rule);
  return {
    ...s,
    workspace,
    check: null,
    candidateText: '',
    previewRev: null,
    adopted: false,
    specRev: s.specRev + 1,
  };
}

const WS = [
  '[shutters]',
  'S1',
  'S2',
  'S3',
  '[rules]',
  'S1 OPEN OR S2 OPEN',
  'S2 CLOSED OR S3 OPEN',
].join('\n');

describe('预检 / 确认隔离状态机', () => {
  it('收紧预检：过期前可确认；草稿编辑后立即过期且确认无效', () => {
    let s = importState(WS);
    s = setDraft(s, 'S2 CLOSED OR S3 CLOSED');
    const pre = runPrecheck(s);
    expect(pre.errors).toEqual([]);
    s = pre.state;
    expect(s.check!.kind).toBe('tightening');
    expect(isStale(s)).toBe(false);

    // 编辑草稿 → 立即过期；确认被拒绝，工作区不变
    const rulesBefore = s.workspace.rules.length;
    s = setDraft(s, 'S2 CLOSED OR S3 OPEN');
    expect(isStale(s)).toBe(true);
    const rejected = confirmCandidate(s);
    expect(rejected).toBe(s);
    expect(rejected.workspace.rules).toHaveLength(rulesBefore);
  });

  it('锁定编辑使预检立即过期；重新预检后才可确认', () => {
    let s = importState(WS);
    s = setDraft(s, 'S2 CLOSED OR S3 CLOSED');
    s = runPrecheck(s).state;
    expect(isStale(s)).toBe(false);

    s = setLock(s, 'S1', 'OPEN');
    expect(isStale(s)).toBe(true);
    expect(confirmCandidate(s)).toBe(s);

    // 重新预检（specRev 对齐）→ 可确认
    s = runPrecheck(s).state;
    expect(isStale(s)).toBe(false);
    const before = s.workspace.rules.length;
    s = confirmCandidate(s);
    expect(s.workspace.rules).toHaveLength(before + 1);
    expect(s.workspace.rules[before].text).toBe('S2 CLOSED OR S3 CLOSED');
    expect(s.workspace.rules[before].index).toBe(before);
    // 确认后旧认证结论失效（须重新认证），采纳状态清除
    expect(s.previewRev).toBeNull();
    expect(s.adopted).toBe(false);
    expect(s.candidateText).toBe('');
    expect(s.check).toBeNull();
  });

  it('导入替换工作区使预检与草稿清空，旧候选不带入', () => {
    let s = importState(WS);
    s = setDraft(s, 'S1 CLOSED OR S2 CLOSED');
    s = runPrecheck(s).state;
    expect(s.check).not.toBeNull();

    // 重新导入（复刻 handleImport：清空草稿/预检，bump rev）
    const r = parseWorkspace('[shutters]\nA\nB\n[rules]\nA OPEN OR B OPEN\n');
    expect(r.ok).toBe(true);
    s = {
      ...s,
      workspace: r.workspace!,
      table: initialTable(r.workspace!.ids),
      locks: {},
      specRev: s.specRev + 1,
      candidateText: '',
      check: null,
      adopted: false,
      previewRev: null,
    };
    expect(isStale(s)).toBe(false);
    expect(s.check).toBeNull();
    expect(s.candidateText).toBe('');
    expect(s.workspace.rules).toHaveLength(1);
    // 旧候选文本在新工作区中没有 S1/S2，即使误确认也无快照可依据
    expect(confirmCandidate(s)).toBe(s);
  });

  it('冲突两类与冗余的确认门禁', () => {
    // 基线冲突
    const unsat = importState(
      [
        '[shutters]',
        'A',
        'B',
        '[rules]',
        'A OPEN OR B OPEN',
        'A OPEN OR B CLOSED',
        'A CLOSED OR B OPEN',
        'A CLOSED OR B CLOSED',
      ].join('\n'),
    );
    let s = setDraft(unsat, 'A CLOSED OR B CLOSED');
    s = runPrecheck(s).state;
    expect(s.check!.kind).toBe('baseline-conflict');
    expect(confirmCandidate(s)).toBe(s);
    expect(s.workspace.rules).toHaveLength(4);

    // 候选冲突：锁 S2=CLOSED 迫使 S1=OPEN，候选 S1 CLOSED OR S2 OPEN 不可满足
    let t = importState(WS);
    t = setLock(t, 'S2', 'CLOSED');
    t = setDraft(t, 'S1 CLOSED OR S2 OPEN');
    t = runPrecheck(t).state;
    expect(t.check!.kind).toBe('candidate-conflict');
    expect(confirmCandidate(t)).toBe(t);
    expect(t.workspace.rules).toHaveLength(2);

    // 冗余：允许确认
    let u = importState(WS);
    u = setDraft(u, 'S1 OPEN OR S2 OPEN');
    u = runPrecheck(u).state;
    expect(u.check!.kind).toBe('redundant');
    u = confirmCandidate(u);
    expect(u.workspace.rules).toHaveLength(3);
  });

  it('预检非法输入：返回错误、不产生快照、确认无效果', () => {
    let s = importState(WS);
    s = setDraft(s, 'S1 FOO OR X CLOSED');
    const r = runPrecheck(s);
    expect(r.errors.join()).toContain('非法状态');
    expect(r.errors.join()).toContain('未知快门 ID');
    s = r.state;
    expect(s.check).toBeNull();
    expect(confirmCandidate(s)).toBe(s);
    expect(s.workspace.rules).toHaveLength(2);
  });

  it('确认后的工作区可独立认证，新规则真实生效（不是只改显示）', () => {
    let s = importState(WS);
    s = setDraft(s, 'S2 CLOSED OR S3 CLOSED');
    s = runPrecheck(s).state;
    s = confirmCandidate(s);
    // 新规则生效后：无锁定最小方案由「S2=CLOSED,S3=OPEN」变为「S2=CLOSED,S3=CLOSED」
    const beforeAdd = solveWorkspace(parseWorkspace(WS).workspace!, {});
    expect(beforeAdd.kind).toBe('sat');
    if (beforeAdd.kind === 'sat') expect(beforeAdd.assignment.S3).toBe('OPEN');
    const afterFree = solveWorkspace(s.workspace, {});
    expect(afterFree.kind).toBe('sat');
    if (afterFree.kind === 'sat') expect(afterFree.assignment.S3).toBe('CLOSED');

    // 锁 S2=OPEN：原规则集可行（S3=OPEN）；新规则与规则 #1 同时强制 S3=CLOSED
    // 与 S3=OPEN → 无解。同样证明新规则真正参与了裁决。
    s = setLock(s, 'S2', 'OPEN');
    const beforeLocked = solveWorkspace(parseWorkspace(WS).workspace!, { S2: 'OPEN' });
    expect(beforeLocked.kind).toBe('sat');
    const after = solveWorkspace(s.workspace, s.locks);
    expect(after.kind).toBe('unsat');
  });

  it('预检期间规则数组身份不被污染（确认才产生追加数组）', () => {
    const s0 = importState(WS);
    let s = setDraft(s0, 'S2 CLOSED OR S3 CLOSED');
    const originalRules = s.workspace.rules;
    s = runPrecheck(s).state;
    expect(s.workspace.rules).toBe(originalRules);
    expect(s.workspace.rules).toHaveLength(2);
    s = confirmCandidate(s);
    expect(s.workspace.rules).not.toBe(originalRules);
  });
});
