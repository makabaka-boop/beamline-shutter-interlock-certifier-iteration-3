import { useState } from 'react';

interface Props {
  onImport: (text: string) => string[];
  onLoadSample: () => string;
}

export function ImportPanel({ onImport, onLoadSample }: Props) {
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [lastOk, setLastOk] = useState(false);

  const doImport = () => {
    const errs = onImport(text);
    setErrors(errs);
    setLastOk(errs.length === 0);
  };

  const loadSample = () => {
    setText(onLoadSample());
    setErrors([]);
  };

  return (
    <section className="panel" data-testid="import-panel">
      <h2>
        导入工作区
        <span className="rule-semantics">
          语法：[shutters] 下列 ID；[rules] 下每行「ID OPEN|CLOSED [OR] ID OPEN|CLOSED」
        </span>
      </h2>
      <textarea
        data-testid="import-text"
        className="import-text"
        rows={10}
        spellCheck={false}
        value={text}
        placeholder={'[shutters]\nS1\nS2\n\n[rules]\nS1 OPEN OR S2 CLOSED'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="import-actions">
        <button type="button" className="primary" data-testid="import-btn" onClick={doImport}>
          校验并导入
        </button>
        <button type="button" data-testid="sample-btn" onClick={loadSample}>
          载入示例
        </button>
        <button type="button" onClick={() => setText('')}>
          清空
        </button>
      </div>
      {errors.length > 0 && (
        <div className="error-box" data-testid="import-errors">
          <strong>导入被整份拒绝，当前工作区保留不变：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {lastOk && errors.length === 0 && (
        <div className="ok-banner" data-testid="import-ok">
          ✓ 导入成功，工作区已替换。
        </div>
      )}
    </section>
  );
}
