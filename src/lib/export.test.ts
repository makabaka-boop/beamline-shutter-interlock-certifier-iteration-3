import { describe, expect, it } from 'vitest';
import type { ShutterState, Workspace } from '../core/types';
import { serializeTable } from './export';

describe('采纳稿序列化', () => {
  it('按 UTF-8 字节序逐行输出 ID + 状态，确定性无多余内容', () => {
    const ws: Workspace = { ids: ['S2', 'S1', 'S10', '中'], rules: [] };
    const table: Record<string, ShutterState> = {
      S1: 'OPEN',
      S2: 'CLOSED',
      S10: 'OPEN',
      中: 'CLOSED',
    };
    expect(serializeTable(ws, table)).toBe(
      'S1 OPEN\nS10 OPEN\nS2 CLOSED\n中 CLOSED\n',
    );
  });

  it('同一表重复序列化结果完全一致（下载与屏幕一致）', () => {
    const ws: Workspace = { ids: ['A', 'B', 'C'], rules: [] };
    const t: Record<string, ShutterState> = { A: 'CLOSED', B: 'OPEN', C: 'CLOSED' };
    expect(serializeTable(ws, t)).toBe(serializeTable(ws, t));
    expect(serializeTable(ws, t)).toBe('A CLOSED\nB OPEN\nC CLOSED\n');
  });

  it('特殊 ID（__proto__ / constructor / toString / OR）逐行导出且与快门一一对应', () => {
    const ws: Workspace = {
      ids: ['toString', '__proto__', 'OR', 'constructor'],
      rules: [],
    };
    const table: Record<string, ShutterState> = Object.fromEntries([
      ['__proto__', 'OPEN'],
      ['constructor', 'CLOSED'],
      ['toString', 'OPEN'],
      ['OR', 'CLOSED'],
    ]);
    // UTF-8 字节序：OR < __proto__ < constructor < toString；不得出现缺失或 [object Object]
    expect(serializeTable(ws, table)).toBe(
      'OR CLOSED\n__proto__ OPEN\nconstructor CLOSED\ntoString OPEN\n',
    );
  });
});
