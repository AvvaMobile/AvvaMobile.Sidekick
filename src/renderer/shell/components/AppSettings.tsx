import { useEffect, useState } from 'react';
import type { AppSettings as Settings } from '../../../shared/settings';
import type { WorkspaceApi } from '../api';
import { Row, Section, SettingsPage } from './SettingsPage';

interface Props {
  api: WorkspaceApi;
  /** Changes whenever the shell state is pushed. */
  refreshKey: unknown;
  onClose(): void;
}

const revealLabel = (platform: string) => (platform === 'darwin' ? 'Reveal in Finder' : platform === 'win32' ? 'Show in Explorer' : 'Show in Folder');

/** App Settings (app menu → Settings…, or the gear on the Projects page). */
export function AppSettings({ api, refreshKey, onClose }: Props) {
  const [s, setS] = useState<Settings | null>(null);

  useEffect(() => {
    let live = true;
    void api.getAppSettings().then((r) => {
      if (live) setS(r);
    });
    return () => {
      live = false;
    };
  }, [api, refreshKey]);

  return (
    <SettingsPage title="Settings" onClose={onClose}>
      {s && (
        <>
          <Section title="Workflow">
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
