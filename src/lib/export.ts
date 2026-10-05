import type { ShutterState, Workspace } from '../core/types';
import { sortByUtf8 } from '../core/utf8';

const encoder = new TextEncoder();

/** 采纳稿序列化为确定性文本：每行「ID STATE」，按 UTF-8 字节序，与屏幕表逐行一致。 */
export function serializeTable(
  workspace: Workspace,
  table: Record<string, ShutterState>,
): string {
  const lines = sortByUtf8(workspace.ids, (id) => id).map(
    (id) => `${id} ${table[id]}`,
  );
  return lines.join('\n') + '\n';
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([encoder.encode(text)], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
