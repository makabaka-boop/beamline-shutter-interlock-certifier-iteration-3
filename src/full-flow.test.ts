import { describe, expect, it } from 'vitest';
import type { ShutterState, Workspace } from './core/types';
import { parseWorkspace } from './core/parser';
import { computeChanges, solveWorkspace } from './core/sat';
import { serializeTable } from './lib/export';
import {
  cycleLockState,
  hasShutterKey,
  initialTable,
  toggleLock,
} from './lib/state';

/**
 * 全链路身份一致性：特殊编号（OR / __proto__ / constructor / toString）与普通
 * 编号混合，走「导入 → 编辑快门表 → 分别锁定/切换锁定值 → 认证 → 改动清单 →
 * 采纳 → 导出」的完整操作员流程，核对这些编号在每一环保持同一身份与状态。
 * 复刻 App 各 handler 的纯函数组合（App 本身只是这些函数的接线）。
 */

const IMPORT_TEXT = [
  '[shutters]',
  'OR',
  '__proto__',
  'constructor',
  'toString',
  'S1',
  'S2',
  '[rules]',
  '# OR 作为第一文字；连接词 OR 居中',
  'OR OPEN OR S1 OPEN',
  '# __proto__ 与 constructor 直接参与规则',
  '__proto__ OPEN OR constructor OPEN',
  '# 省略连接词，toString 为普通第一文字',
  'toString CLOSED S2 CLOSED',
].join('\n');

/** UTF-8 字节序：OR < S1 < S2 < __proto__ < constructor < toString */
const SORTED = ['OR', 'S1', 'S2', '__proto__', 'constructor', 'toString'];

function importOk(text: string): Workspace {
  const r = parseWorkspace(text);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  return r.workspace!;
}

describe('全链路：特殊编号与普通编号混合的一致身份', () => {
  it('导入 → 锁定 → 认证 → 改动 → 采纳 → 导出逐行对应', () => {
    const ws = importOk(IMPORT_TEXT);
    expect(ws.rules).toHaveLength(3);
    // 规则中的 OR / __proto__ 引用被解析为真实快门
    expect(ws.rules[0]).toMatchObject({
      a: { id: 'OR', state: 'OPEN' },
      b: { id: 'S1', state: 'OPEN' },
    });
    expect(ws.rules[1]).toMatchObject({
      a: { id: '__proto__', state: 'OPEN' },
      b: { id: 'constructor', state: 'OPEN' },
    });

    // 初始快门表：每个编号都有独立条目
    let table = initialTable(ws.ids);
    expect(Object.keys(table)).toHaveLength(6);
    for (const id of SORTED) expect(table[id]).toBe('CLOSED');

    // 手工切换一个普通编号的状态（复刻 handleSetTable 的写法）
    table = { ...table, ['S2']: 'OPEN' };
    expect(table['S2']).toBe('OPEN');

    // 分别锁定：__proto__ 锁到当前表值 CLOSED；toString 锁定后切换为 OPEN
    let locks: Record<string, ShutterState> = {};
    expect(hasShutterKey(locks, 'toString')).toBe(false); // 继承属性不算已锁
    expect(hasShutterKey(locks, '__proto__')).toBe(false);
    locks = toggleLock(locks, '__proto__', table['__proto__']);
    locks = toggleLock(locks, 'toString', table['toString']);
    locks = cycleLockState(locks, 'toString'); // CLOSED → OPEN
    // 锁数量与实际锁定一一对应
    expect(Object.keys(locks)).toHaveLength(2);
    expect(locks['__proto__']).toBe('CLOSED');
    expect(locks['toString']).toBe('OPEN');

    // 认证：可满足；方案完整且遵守锁定
    const outcome = solveWorkspace(ws, locks);
    expect(outcome.kind).toBe('sat');
    if (outcome.kind !== 'sat') return;
    expect(outcome.orderedIds).toEqual(SORTED);
    expect(Object.keys(outcome.assignment)).toHaveLength(6);
    // 期望值同样用 fromEntries 构造：字面量 __proto__: 键不会成为自有属性
    const expected: Record<string, ShutterState> = Object.fromEntries(
      [
        ['OR', 'CLOSED'],
        ['S1', 'OPEN'], // 规则 0：OR=CLOSED 时 S1 必须 OPEN
        ['S2', 'CLOSED'],
        ['__proto__', 'CLOSED'], // 锁定
        ['constructor', 'OPEN'], // 规则 1：__proto__=CLOSED 时 constructor 必须 OPEN
        ['toString', 'OPEN'], // 锁定
      ] as Array<[string, ShutterState]>,
    );
    expect({ ...outcome.assignment }).toEqual(expected);
    for (const id of SORTED) {
      expect(outcome.assignment[id]).toBe(expected[id]);
    }

    // 改动清单：相对当前表（S2 被手工置 OPEN）逐条对应
    const changes = computeChanges(outcome.orderedIds, outcome.assignment, table);
    expect(changes).toEqual([
      { id: 'S1', from: 'CLOSED', to: 'OPEN' },
      { id: 'S2', from: 'OPEN', to: 'CLOSED' },
      { id: 'constructor', from: 'CLOSED', to: 'OPEN' },
      { id: 'toString', from: 'CLOSED', to: 'OPEN' },
    ]);

    // 采纳（复刻 handleAdopt 的展开复制）后导出：逐行 ID STATE，与快门一一对应
    table = { ...outcome.assignment };
    expect(table['__proto__']).toBe('CLOSED');
    expect(serializeTable(ws, table)).toBe(
      [
        'OR CLOSED',
        'S1 OPEN',
        'S2 CLOSED',
        '__proto__ CLOSED',
        'constructor OPEN',
        'toString OPEN',
      ].join('\n') + '\n',
    );
  });

  it('特殊编号参与双锁冲突：判无解且见证为字节序最小矛盾快门', () => {
    const ws = importOk(IMPORT_TEXT);
    // 锁 OR=CLOSED 且 S1=CLOSED，直接违反规则 0（OR OPEN ∨ S1 OPEN）
    let locks: Record<string, ShutterState> = {};
    locks = toggleLock(locks, 'OR', 'CLOSED');
    locks = toggleLock(locks, 'S1', 'CLOSED');
    expect(Object.keys(locks)).toHaveLength(2);

    const outcome = solveWorkspace(ws, locks);
    expect(outcome.kind).toBe('unsat');
    if (outcome.kind !== 'unsat') return;
    // OR(0x4F) < S1(0x53)：见证取字节序最小者
    expect(outcome.witness.id).toBe('OR');
    expect(outcome.witness.openToClosed.length).toBeGreaterThan(0);
    expect(outcome.witness.closedToOpen.length).toBeGreaterThan(0);

    // 解锁 OR 后恢复可行（复刻解锁路径）
    locks = toggleLock(locks, 'OR', 'CLOSED');
    expect(Object.keys(locks)).toHaveLength(1);
    expect(hasShutterKey(locks, 'OR')).toBe(false);
    const again = solveWorkspace(ws, locks);
    expect(again.kind).toBe('sat');
    if (again.kind !== 'sat') return;
    expect(again.assignment['S1']).toBe('CLOSED'); // 唯一锁定 S1=CLOSED…
    expect(again.assignment['OR']).toBe('OPEN'); // …故规则 0 要求 OR=OPEN
    expect(Object.keys(again.assignment)).toHaveLength(6);
  });
});
