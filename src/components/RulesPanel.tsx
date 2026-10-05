import type { Workspace } from '../core/types';

export function RulesPanel({ workspace }: { workspace: Workspace }) {
  return (
    <ol className="rules-list" data-testid="rules-list">
      {workspace.rules.map((r) => (
        <li key={r.index} data-testid={`rule-${r.index}`} className="mono">
          <span className="rule-no">#{r.index}</span>
          <span className="rule-text">{r.text}</span>
        </li>
      ))}
    </ol>
  );
}
