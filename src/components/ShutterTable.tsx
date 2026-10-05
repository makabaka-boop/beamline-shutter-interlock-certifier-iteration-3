import type { ShutterState } from '../core/types';
import { hasShutterKey } from '../lib/state';

interface Props {
  ids: string[];
  table: Record<string, ShutterState>;
  locks: Record<string, ShutterState>;
  onSetTable: (id: string, state: ShutterState) => void;
  onToggleLock: (id: string) => void;
  onCycleLockState: (id: string) => void;
}

export function ShutterTable({
  ids,
  table,
  locks,
  onSetTable,
  onToggleLock,
  onCycleLockState,
}: Props) {
  return (
    <table className="shutter-table" data-testid="shutter-table">
      <thead>
        <tr>
          <th>快门 ID（UTF-8 字节序）</th>
          <th>当前状态</th>
          <th>临时锁定</th>
        </tr>
      </thead>
      <tbody>
        {ids.map((id) => {
          // 只看自有属性：constructor / toString 等继承成员不算已锁定
          const locked = hasShutterKey(locks, id);
          return (
            <tr key={id} data-testid={`shutter-row-${id}`}>
              <td className="mono">{id}</td>
              <td>
                <div className="state-toggle" role="radiogroup" aria-label={`${id} 状态`}>
                  {(['CLOSED', 'OPEN'] as ShutterState[]).map((s) => (
                    <label key={s} className={`state-opt ${s.toLowerCase()}`}>
                      <input
                        type="radio"
                        name={`state-${id}`}
                        data-testid={`state-${id}-${s}`}
                        checked={table[id] === s}
                        onChange={() => onSetTable(id, s)}
                      />
                      {s}
                    </label>
                  ))}
                </div>
              </td>
              <td>
                <div className="lock-cell">
                  <button
                    type="button"
                    className={locked ? 'lock-btn locked' : 'lock-btn'}
                    data-testid={`lock-${id}`}
                    onClick={() => onToggleLock(id)}
                  >
                    {locked ? '解锁' : '锁定'}
                  </button>
                  {locked && (
                    <button
                      type="button"
                      className="lock-state"
                      data-testid={`lock-state-${id}`}
                      title="点击切换锁定到的状态"
                      onClick={() => onCycleLockState(id)}
                    >
                      锁定为 {locks[id]} ⇄
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
