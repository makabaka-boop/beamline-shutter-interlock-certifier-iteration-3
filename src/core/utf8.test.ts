import { describe, expect, it } from 'vitest';
import { compareUtf8, minByUtf8, sortByUtf8 } from './utf8';

describe('UTF-8 字节序', () => {
  it('ASCII 按字节排序', () => {
    expect(compareUtf8('A', 'B')).toBeLessThan(0);
    expect(compareUtf8('S10', 'S2')).toBeLessThan(0); // '1' < '2'
    expect(compareUtf8('ab', 'abc')).toBeLessThan(0); // 短前缀更小
    expect(compareUtf8('abc', 'abc')).toBe(0);
  });

  it('多字节字符按 UTF-8 字节而非码元比较', () => {
    // 'z' = 0x7A，'é' = 0xC3 0xA9：z 在前
    expect(compareUtf8('z', 'é')).toBeLessThan(0);
    // 'A' = 0x41 早于 '中' = 0xE4 0xB8 0xAD
    expect(compareUtf8('A', '中')).toBeLessThan(0);
    // 'é'(C3 A9) 早于 '中'(E4 B8 AD)
    expect(compareUtf8('é', '中')).toBeLessThan(0);
  });

  it('sort / min 辅助函数', () => {
    expect(sortByUtf8(['S2', 'S10', 'S1'], (s) => s)).toEqual([
      'S1',
      'S10',
      'S2',
    ]);
    expect(minByUtf8(['中', 'A', 'z'], (s) => s)).toBe('A');
  });
});
