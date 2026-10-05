import { describe, expect, it } from 'vitest';
import { parseWorkspace, MAX_SHUTTERS, MAX_RULES } from './parser';

const OK = `
# 注释行
[shutters]
S1
S2
S3

[rules]
S1 OPEN OR S2 CLOSED
S3 OPEN S1 CLOSED
`;

describe('导入解析', () => {
  it('解析合法工作区（OR 关键字可省略）', () => {
    const r = parseWorkspace(OK);
    expect(r.ok).toBe(true);
    expect(r.workspace?.ids).toEqual(['S1', 'S2', 'S3']);
    expect(r.workspace?.rules).toHaveLength(2);
    expect(r.workspace?.rules[0]).toMatchObject({
      a: { id: 'S1', state: 'OPEN' },
      b: { id: 'S2', state: 'CLOSED' },
    });
    // “S3 OPEN S1 CLOSED” 无 OR 也被视为两个文字
    expect(r.workspace?.rules[1]).toMatchObject({
      a: { id: 'S3', state: 'OPEN' },
      b: { id: 'S1', state: 'CLOSED' },
    });
  });

  it('未知 ID 拒绝整份导入且无 workspace', () => {
    const text = `[shutters]\nA\nB\n[rules]\nA OPEN OR X CLOSED\n`;
    const r = parseWorkspace(text);
    expect(r.ok).toBe(false);
    expect(r.workspace).toBeNull();
    expect(r.errors.join('\n')).toContain('未知快门 ID');
  });

  it('非法状态拒绝整份导入', () => {
    const text = `[shutters]\nA\nB\n[rules]\nA OPEN OR B OPENED\n`;
    const r = parseWorkspace(text);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('非法状态');
  });

  it('重复快门 ID 拒绝整份导入', () => {
    const text = `[shutters]\nA\nB\nA\n[rules]\nA OPEN OR B OPEN\n`;
    const r = parseWorkspace(text);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('重复声明');
  });

  it('同一规则内同一快门重复出现（含正反文字）拒绝', () => {
    const text = `[shutters]\nA\nB\n[rules]\nA OPEN OR A CLOSED\n`;
    const r = parseWorkspace(text);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('重复出现');
  });

  it('记号数量不对、缺少小节、快门不足均拒绝', () => {
    expect(parseWorkspace('[shutters]\nA\n[rules]\nA OPEN OR B OPEN\n').ok).toBe(false); // 未知ID + 仅 1 快门
    const onlyOne = parseWorkspace('[shutters]\nA\n[rules]\n');
    expect(onlyOne.ok).toBe(false);
    expect(onlyOne.errors.join('\n')).toContain('至少需要 2');
    const noSections = parseWorkspace('A OPEN OR B CLOSED\n');
    expect(noSections.ok).toBe(false);
    const badLine = parseWorkspace('[shutters]\nA B\n[rules]\n');
    expect(badLine.ok).toBe(false);
    expect(badLine.errors.join('\n')).toContain('空白');
  });

  it('状态关键字不能用作 ID', () => {
    const r = parseWorkspace('[shutters]\nOPEN\nB\n[rules]\n');
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('OPEN');
  });

  it('超限拒绝', () => {
    const many = Array.from({ length: MAX_SHUTTERS + 1 }, (_, i) => `X${i}`).join('\n');
    const r = parseWorkspace(`[shutters]\n${many}\n[rules]\n`);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('最多允许');

    const rules = Array.from({ length: MAX_RULES + 1 }, () => 'X0 OPEN OR X1 OPEN').join('\n');
    const r2 = parseWorkspace(
      `[shutters]\nX0\nX1\n[rules]\n${rules}\n`,
    );
    expect(r2.ok).toBe(false);
    expect(r2.errors.join('\n')).toContain('规则数量');
  });
});

describe('特殊快门 ID（OR / __proto__ / constructor / toString）', () => {
  it('OR 可登记为快门 ID 并在规则两个文字位置引用（含省略连接词）', () => {
    const text = [
      '[shutters]',
      'OR',
      'S1',
      'S2',
      '[rules]',
      'OR OPEN OR S1 CLOSED',
      'S1 OPEN OR CLOSED',
      'OR CLOSED S2 OPEN',
      'S1 OPEN or OR CLOSED',
    ].join('\n');
    const r = parseWorkspace(text);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.workspace?.ids).toEqual(['OR', 'S1', 'S2']);
    expect(r.workspace?.rules).toHaveLength(4);
    // 连接词在中间：OR 是第一文字的 ID
    expect(r.workspace?.rules[0]).toMatchObject({
      a: { id: 'OR', state: 'OPEN' },
      b: { id: 'S1', state: 'CLOSED' },
    });
    // 无连接词：第 3 个记号即第二文字的 ID（此处为 OR）
    expect(r.workspace?.rules[1]).toMatchObject({
      a: { id: 'S1', state: 'OPEN' },
      b: { id: 'OR', state: 'CLOSED' },
    });
    expect(r.workspace?.rules[2]).toMatchObject({
      a: { id: 'OR', state: 'CLOSED' },
      b: { id: 'S2', state: 'OPEN' },
    });
    // 小写连接词 + OR 作为第二文字
    expect(r.workspace?.rules[3]).toMatchObject({
      a: { id: 'S1', state: 'OPEN' },
      b: { id: 'OR', state: 'CLOSED' },
    });
  });

  it('OR 作为 ID 时同一规则内重复出现仍拒绝', () => {
    const r = parseWorkspace('[shutters]\nOR\nS1\n[rules]\nOR OPEN OR OR CLOSED\n');
    expect(r.ok).toBe(false);
    expect(r.workspace).toBeNull();
    expect(r.errors.join('\n')).toContain('重复出现');
  });

  it('__proto__ / constructor / toString 可登记并在规则中引用', () => {
    const text = [
      '[shutters]',
      '__proto__',
      'constructor',
      'toString',
      '[rules]',
      '__proto__ OPEN OR constructor CLOSED',
      'toString OPEN __proto__ CLOSED',
    ].join('\n');
    const r = parseWorkspace(text);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.workspace?.ids).toEqual(['__proto__', 'constructor', 'toString']);
    expect(r.workspace?.rules).toHaveLength(2);
    expect(r.workspace?.rules[0]).toMatchObject({
      a: { id: '__proto__', state: 'OPEN' },
      b: { id: 'constructor', state: 'CLOSED' },
    });
    expect(r.workspace?.rules[1]).toMatchObject({
      a: { id: 'toString', state: 'OPEN' },
      b: { id: '__proto__', state: 'CLOSED' },
    });
  });

  it('普通编号与 OR 连接语法保持兼容（可省略、可小写、可重复书写）', () => {
    const text = [
      '[shutters]',
      'A',
      'B',
      '[rules]',
      'A OPEN OR B CLOSED',
      'A OPEN B CLOSED',
      'A OPEN or B CLOSED',
      'A OPEN OR OR B CLOSED',
    ].join('\n');
    const r = parseWorkspace(text);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.workspace?.rules).toHaveLength(4);
    for (const rule of r.workspace!.rules) {
      expect(rule).toMatchObject({
        a: { id: 'A', state: 'OPEN' },
        b: { id: 'B', state: 'CLOSED' },
      });
    }
  });

  it('连接词位置非法或记号数量错误仍整份拒绝', () => {
    const bad = [
      'OR A OPEN B CLOSED', // 连接词出现在行首
      'A OPEN B CLOSED OR', // 连接词出现在行尾
      'A OPEN OR B CLOSED EXTRA', // 记号过多
      'A OPEN B', // 记号不足
    ];
    for (const line of bad) {
      const r = parseWorkspace(`[shutters]\nA\nB\n[rules]\n${line}\n`);
      expect(r.ok, `「${line}」应被拒绝`).toBe(false);
      expect(r.workspace).toBeNull();
    }
  });
});
