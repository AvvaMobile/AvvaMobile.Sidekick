import { useState } from 'react';

export type DiagnosticsApi = Record<'state' | 'micStatus' | 'home' | 'submit', () => Promise<unknown>> & {
  insert(text: string): Promise<unknown>;
};

/**
 * ChatGPT adapter diagnostics (development-only, D025). Rendered only when Developer → Diagnostics
 * is enabled; the main process also refuses these calls otherwise.
 */
export function DiagnosticsPanel({ api }: { api: DiagnosticsApi }) {
  const [log, setLog] = useState('');
  const [text, setText] = useState('Sidekick diagnostics insertion test.');
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    const v = await fn();
    setLog((l) => `[${new Date().toLocaleTimeString()}] ${label}: ${JSON.stringify(v, null, 2)}\n${l}`.slice(0, 50_000));
  };
  return (
    <div className="diagnostics" data-testid="diagnostics">
      <div className="diag-note">Developer → Diagnostics. Not part of the product UI.</div>
      <div className="diag-row">
        <button className="btn small" onClick={run('state', api.state)}>Page state</button>
        <button className="btn small" onClick={run('mic', api.micStatus)}>Mic status</button>
        <button className="btn small" onClick={run('home', api.home)}>Home</button>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <div className="diag-row">
        <button className="btn small" onClick={run('insert', () => api.insert(text))}>Insert into composer</button>
        <button className="btn small" onClick={run('submit', api.submit)}>Submit</button>
      </div>
      <pre className="diag-log">{log}</pre>
    </div>
  );
}
