import { useState } from 'react';
import type { WorkspaceApi } from '../api';
import { shortPath } from '../viewModel';

/** Minimal Workspace creation: project name + local working directory (D014). */
export function NewWorkspaceDialog({ api, onClose }: { api: WorkspaceApi; onClose(): void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pick = async () => {
    const r = await api.pickFolder();
    if (!r) return;
    setPath(r.path);
    if (!name.trim()) setName(r.name);
  };
  const create = async () => {
    if (!path) return setError('Choose the project folder.');
    setSaving(true);
    const r = await api.createWorkspace(name, path);
    setSaving(false);
    if (r.ok) onClose();
    else setError(r.detail ?? 'Could not create the Workspace.');
  };

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-label="New Workspace"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2>New Workspace</h2>
        <label className="field">
          <span>Project name</span>
          <input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Mobile" />
        </label>
        <div className="field">
          <span>Working directory</span>
          <div className="folder-row">
            <code className="folder">{path ? shortPath(path) : 'No folder chosen'}</code>
            <button type="button" className="btn small" onClick={() => void pick()}>
              Choose…
            </button>
          </div>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving || !path || !name.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
