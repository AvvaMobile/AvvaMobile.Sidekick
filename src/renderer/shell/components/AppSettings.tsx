import { useEffect, useState } from 'react';
import type { AppSettings as Settings, AppSettingsPatch } from '../../../shared/settings';
import type { WorkspaceApi } from '../api';
import { Row, Section, SettingsPage } from './SettingsPage';

interface Props {
  api: WorkspaceApi;
  /** Changes whenever the shell state is pushed (another window or the menu changed a setting). */
  refreshKey: unknown;
  onClose(): void;
}

const revealLabel = (platform: string) => (platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in Folder');

/** App Settings (app menu → Settings…, or the gear on the Projects page). Changes are saved immediately. */
export function AppSettings({ api, refreshKey, onClose }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api.getAppSettings().then((r) => {
      if (live) setS(r);
    });
    return () => {
      live = false;
    };
  }, [api, refreshKey]);

  const update = async (patch: AppSettingsPatch) => {
    const r = await api.updateAppSettings(patch);
    if (r.ok) {
      setError(null);
      setS(r.settings);
    } else setError(r.detail ?? 'Not saved.');
  };

  return (
    <SettingsPage title="Settings" onClose={onClose}>
      {s && (
        <>
          <Section title="Workflow">
            <Row label="Auto-send when I ask ChatGPT" hint="If your ChatGPT message says “send this to Claude”, a ready prompt is sent after a 3 s countdown you can cancel." error={error}>
              <label className="switch">
                <input type="checkbox" aria-label="Auto-send when I ask ChatGPT" checked={s.autoSendOnRequest} onChange={(e) => void update({ autoSendOnRequest: e.target.checked })} />
                <span>{s.autoSendOnRequest ? 'On' : 'Off'}</span>
              </label>
            </Row>
            <Row
              label="Default Claude model"
              hint={
                <>
                  Comes from Claude Code’s own settings (<code>~/.claude/settings.json</code> or <code>/model</code>). Each project can override it in its Project Settings.
                </>
              }
            >
              <span className="set-value">{s.defaultModel ? s.defaultModel[0]!.toUpperCase() + s.defaultModel.slice(1) : 'Claude Code default'}</span>
            </Row>
          </Section>

          <Section title="Developer">
            <Row label="Developer mode" hint="Shows the diagnostics tools in the development pane.">
              <label className="switch">
                <input type="checkbox" aria-label="Developer mode" checked={s.developerMode} onChange={(e) => void update({ developerMode: e.target.checked })} />
                <span>{s.developerMode ? 'On' : 'Off'}</span>
              </label>
            </Row>
          </Section>

          <Section title="About">
            <Row label="Version">
              <span className="set-value">{s.version}</span>
            </Row>
            <Row label="App data" hint="Projects, logs and custom icons are stored here.">
              <div className="folder-row">
                <code className="folder" title={s.userDataPath}>
                  {s.userDataPath}
                </code>
                <button className="btn small" onClick={() => void api.revealUserData()}>
                  {revealLabel(api.platform)}
                </button>
              </div>
            </Row>
          </Section>
        </>
      )}
    </SettingsPage>
  );
}
