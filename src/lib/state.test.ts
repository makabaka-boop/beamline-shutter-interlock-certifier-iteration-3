import { describe, expect, it } from 'vitest';
import type { ShutterState } from '../core/types';
import {
  cycleLockState,
  hasShutterKey,
  initialTable,
  toggleLock,
} from './state';

const hasOwn = (rec: Record<string, ShutterState>, id: string) =>
  Object.prototype.hasOwnProperty.call(rec, id);

describe('快门表 / 锁定记录：特殊 ID（__proto__ / constructor / toString / OR）', () => {
  const special = ['__proto__', 'constructor', 'toString', 'OR'];

  it('initialTable 为每个 ID 建立独立自有条目，全部 CLOSED', () => {
    const t = initialTable([...special, 'S1']);
    expect(Object.keys(t)).toHaveLength(5);
    for (const id of [...special, 'S1']) {
      expect(hasOwn(t, id)).toBe(true);
      expect(t[id]).toBe('CLOSED');
    }
  });

  it('未锁定时继承属性（constructor / toString / __proto__）不误判为已锁定', () => {
    const empty: Record<string, ShutterState> = {};
    for (const id of [...special, 'hasOwnProperty', 'valueOf']) {
      expect(hasShutterKey(empty, id)).toBe(false);
    }
  });

  it('__proto__ 可锁定、切换锁定值、解锁，锁数量始终准确', () => {
    let locks: Record<string, ShutterState> = {};
    locks = toggleLock(locks, '__proto__', 'CLOSED');
    expect(Object.keys(locks)).toEqual(['__proto__']);
    expect(hasShutterKey(locks, '__proto__')).toBe(true);
    expect(locks['__proto__']).toBe('CLOSED');

    locks = cycleLockState(locks, '__proto__');
    expect(locks['__proto__']).toBe('OPEN');
    expect(Object.keys(locks)).toHaveLength(1);

    locks = toggleLock(locks, '__proto__', 'CLOSED'); // 已锁定 → 解锁
    expect(Object.keys(locks)).toHaveLength(0);
    expect(hasShutterKey(locks, '__proto__')).toBe(false);
  });

  it('constructor / toString / OR 与普通 ID 混合锁定互不影响', () => {
    let locks: Record<string, ShutterState> = {};
    locks = toggleLock(locks, 'constructor', 'OPEN');
    locks = toggleLock(locks, 'toString', 'CLOSED');
    locks = toggleLock(locks, 'OR', 'CLOSED');
    locks = toggleLock(locks, 'S1', 'OPEN');
    expect(Object.keys(locks)).toHaveLength(4);
    expect(locks['constructor']).toBe('OPEN');
    expect(locks['toString']).toBe('CLOSED');

    locks = cycleLockState(locks, 'constructor');
    expect(locks['constructor']).toBe('CLOSED');
    expect(Object.keys(locks)).toHaveLength(4);

    // 未锁定的 ID 切换锁定值不应产生新条目（即使名为 hasOwnProperty）
    locks = cycleLockState(locks, 'hasOwnProperty');
    expect(Object.keys(locks)).toHaveLength(4);
    expect(hasShutterKey(locks, 'hasOwnProperty')).toBe(false);

    // 逐个解锁后记录清空
    for (const id of ['constructor', 'toString', 'OR', 'S1']) {
      locks = toggleLock(locks, id, 'CLOSED');
    }
    expect(Object.keys(locks)).toHaveLength(0);
  });

  it('锁定记录经过展开复制后 __proto__ 条目保持独立自有', () => {
    const locks = toggleLock({}, '__proto__', 'OPEN');
    const copy = { ...locks };
    expect(hasOwn(copy, '__proto__')).toBe(true);
    expect(copy['__proto__']).toBe('OPEN');
    // 复制不影响原记录
    expect(Object.keys(locks)).toEqual(['__proto__']);
  });
});
