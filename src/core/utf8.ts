const encoder = new TextEncoder();

/** 比较两个字符串的 UTF-8 字节序（逐字节无符号比较，前缀短的更小）。 */
export function compareUtf8(a: string, b: string): number {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/** 按 UTF-8 字节序排序（返回新数组）。 */
export function sortByUtf8<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareUtf8(key(x), key(y)));
}

export function minByUtf8<T>(items: T[], key: (item: T) => string): T {
  let best = items[0];
  for (let i = 1; i < items.length; i++) {
    if (compareUtf8(key(items[i]), key(best)) < 0) best = items[i];
  }
  return best;
}
