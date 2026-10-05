/// <reference types="vite/client" />

export type ShutterState = 'OPEN' | 'CLOSED';

/** 一条文字：某快门处于某状态 */
export interface Literal {
  id: string;
  state: ShutterState;
}

/**
 * 二元规则：两个文字，含义为“至少一个成立”（析取子句）。
 * index 为规则在导入中的序号（从 0 起），text 保留原文便于逐步复核。
 */
export interface Rule {
  index: number;
  a: Literal;
  b: Literal;
  text: string;
}

export interface Workspace {
  ids: string[];
  rules: Rule[];
}

export interface ImportResult {
  ok: boolean;
  errors: string[];
  workspace: Workspace | null;
}

export type ChangeAction = ShutterState;

export interface Change {
  id: string;
  from: ShutterState;
  to: ShutterState;
}

/** 蕴含图上的一条边，并指回其来源规则（或锁定 / 贪心试设） */
export type EdgeReason =
  | { kind: 'rule'; ruleIndex: number }
  | { kind: 'lock'; id: string; state: ShutterState }
  | { kind: 'assume'; i: number; state: ShutterState };

export interface Edge {
  from: number;
  to: number;
  reason: EdgeReason;
}

/** 蕴含路径上的一步：from --(依据)--> to */
export interface ImplicationStep {
  from: Literal;
  to: Literal;
  reason: EdgeReason;
}

export interface ConflictWitness {
  id: string;
  openToClosed: ImplicationStep[];
  closedToOpen: ImplicationStep[];
}

export type SolveOutcome =
  | {
      kind: 'sat';
      assignment: Record<string, ShutterState>;
      orderedIds: string[];
    }
  | {
      kind: 'unsat';
      witness: ConflictWitness;
    };

/**
 * 锁定修复建议（仅在认证无解时计算）。
 * 规则与快门表一律不变，唯一允许的修复手段是「撤销若干临时锁定」——
 * 不修改规则、不翻转锁定值、不直接套用旧快门表。
 */
export type LockRepair =
  | {
      kind: 'suggestion';
      /** 需撤销的锁定快门 ID，按 UTF-8 字节序；长度为精确最少撤销数 */
      remove: string[];
      /** 撤销所列锁定后，由原 2-SAT 求解器给出的字典序最小完整方案 */
      outcome: Extract<SolveOutcome, { kind: 'sat' }>;
    }
  /** 全部解锁后规则仍无解：规则自身冲突，不提供修复建议 */
  | { kind: 'rules-conflict' }
  /** 锁定数超过精确求解上限，未计算建议 */
  | { kind: 'too-many-locks'; count: number };
