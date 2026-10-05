import { useCallback, useEffect, useState } from 'react';
import { SIDEBAR_COLORS } from '../../../domain/workspace/workspace';
import { MODEL_CHOICES, type ModelChoice } from '../../../shared/models';
import type { ProjectSettings as Settings, ProjectSettingsPatch } from '../../../shared/settings';
import type { WorkspaceApi } from '../api';
import type { GithubAccess } from '../../../shared/github';
import { Row, Section, SettingsPage } from './SettingsPage';

type Field = 'name' | 'path' | 'color' | 'icon' | 'model' | 'chat' | 'github' | 'session' | 'danger';

const label = (m: ModelChoice) => m[0]!.toUpperCase() + m.slice(1);

const PERMISSION_LABEL = { read: 'read', triage: 'triage', write: 'read/write', maintain: 'maintain', admin: 'admin' } as const;

/** Visible verification state for the repository field. */
export function githubStatusText(a: GithubAccess, checking: boolean): { mark: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  if (checking) return { mark: '…', text: 'Checking…', tone: 'idle' };
  switch (a.status) {
    case 'accessible':
      return { mark: '✓', text: `Accessible${a.permission ? ` — ${PERMISSION_LABEL[a.permission]}` : ''}`, tone: 'ok' };
    case 'no-access':
      return { mark: '✕', text: 'No access to this repository', tone: 'bad' };
    case 'not-found':
      return { mark: '✕', text: 'Repository not found or you do not have access', tone: 'bad' };
    case 'auth-required':
      return { mark: '⚠', text: 'Authentication required — connect GitHub (gh auth login), then verify', tone: 'warn' };
    case 'error':
      return { mark: '⚠', text: 'Verification failed — try again', tone: 'warn' };
    default:
      return { mark: '', text: 'Not checked', tone: 'idle' };
  }
}

interface Props {
  api: WorkspaceApi;
  workspaceId: string;
  /** Changes whenever the shell state is pushed: the screen re-reads its settings. */
  refreshKey: unknown;
  onClose(): void;
}

/** Project Settings (tab right-click → Settings…): every per-project setting, saved as soon as it changes. */
export function ProjectSettings({ api, workspaceId, refreshKey, onClose }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [name, setName] = useState('');
  const [chatLink, setChatLink] = useState('');
  const [repo, setRepo] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    void api.getProjectSettings(workspaceId).then((r) => {
      if (live) setS(r);
    });
    return () => {
      live = false;
    };
  }, [api, workspaceId, refreshKey]);
  // Drafts follow the saved value whenever it changes.
  useEffect(() => setName(s?.name ?? ''), [s?.name]);
  useEffect(() => setChatLink(s?.chatConversationUrl ?? ''), [s?.chatConversationUrl]);
  useEffect(() => setRepo(s?.githubRepository ?? ''), [s?.githubRepository]);

  const fail = (f: Field, detail?: string) => setErrors((e) => ({ ...e, [f]: detail || 'Not saved.' }));
  const clear = (f: Field) => setErrors((e) => ({ ...e, [f]: undefined }));

  const update = useCallback(
    async (f: Field, patch: ProjectSettingsPatch) => {
      const r = await api.updateProjectSettings(workspaceId, patch);
      if (r.ok) {
        clear(f);
        if (r.settings) setS(r.settings);
      } else if (r.code !== 'cancelled') fail(f, r.detail);
      return r.ok;
    },
    [api, workspaceId],
  );

  if (!s) return <SettingsPage title="Settings" onClose={onClose}>{null}</SettingsPage>;

  const commitName = () => {
    if (name.trim().replace(/\s+/g, ' ') === s.name) return clear('name');
    void update('name', { name });
  };
  const commitChatLink = () => {
    const v = chatLink.trim();
    if (v === (s.chatConversationUrl ?? '')) return clear('chat');
    void update('chat', { chatConversationUrl: v === '' ? null : v });
  };
  const verifyGithub = async () => {
    setChecking(true);
    try {
      const r = await api.verifyGithub(workspaceId);
      if (r.ok) {
        clear('github');
        if (r.settings) setS(r.settings);
      } else fail('github', r.detail);
    } finally {
      setChecking(false);
    }
  };
  const commitRepo = async () => {
    const v = repo.trim();
    if (v === (s.githubRepository ?? '')) return clear('github');
    const r = await api.updateProjectSettings(workspaceId, { githubRepository: v === '' ? null : v });
    if (!r.ok) return fail('github', r.detail);
    clear('github');
    if (r.settings) {
      setS(r.settings);
      setRepo(r.settings.githubRepository ?? ''); // show the normalized value even when it equals the saved one
    }
    // The repository is saved even without authentication; check it once right after saving.
    if (v !== '') await verifyGithub();
  };
  const changeFolder = async () => {
    const r = await api.pickFolder();
    if (!r || r.path === s.projectPath) return;
    await update('path', { projectPath: r.path });
  };
  const chooseIcon = async () => {
    const r = await api.chooseIcon(s.id);
    if (r.ok) {
      clear('icon');
      setS(await api.getProjectSettings(s.id));
    } else if (r.code !== 'cancelled') fail('icon', r.detail);
  };
  const busyNote = s.taskActive ? 'Claude is running a task in this project.' : null;

  return (
    <SettingsPage title={`${s.name} — Settings`} onClose={onClose}>
      <Section title="Project">
        <Row label="Name" hint="Shown on the tab and in the window title." error={errors.name}>
          <input
            className="set-input"
            aria-label="Project name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
            }}
          />
        </Row>
        <Row label="Project folder" hint="The terminal and Claude Code run here." error={errors.path}>
          <div className="folder-row">
            <code className="folder" title={s.projectPath}>
              {s.projectPath}
            </code>
            <button className="btn small" onClick={() => void changeFolder()} disabled={s.taskActive}>
              Change…
            </button>
          </div>
        </Row>
        <Row label="Color" hint="Used for the tab when there is no custom icon." error={errors.color}>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {SIDEBAR_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={s.color === c}
                aria-label={c}
                className={`swatch ${s.color === c ? 'on' : ''}`}
                style={{ background: c }}
                onClick={() => void update('color', { color: c })}
              />
            ))}
            <input type="color" className="swatch-custom" aria-label="Custom color" value={s.color} onChange={(e) => void update('color', { color: e.target.value })} />
          </div>
        </Row>
        <Row label="Icon" error={errors.icon}>
          <div className="icon-row">
            {s.iconUrl ? (
              <img className="icon-preview" src={s.iconUrl} alt="" />
            ) : (
              <span className="icon-preview initial" style={{ background: s.color }}>
                {s.initial}
              </span>
            )}
            <button className="btn small" onClick={() => void chooseIcon()}>
              Choose Image…
            </button>
            <button className="btn small" disabled={!s.iconUrl} onClick={() => void update('icon', { icon: null })}>
              Use Initial
            </button>
          </div>
        </Row>
      </Section>

      <Section title="Claude">
        <Row label="Model" hint="Changing it restarts the terminal's Claude Code (same session)." error={errors.model}>
          <div className="seg" role="radiogroup" aria-label="Claude model">
            <button role="radio" aria-checked={s.model === null} className={s.model === null ? 'on' : ''} onClick={() => s.model !== null && void update('model', { model: null })}>
              App default{s.defaultModel ? ` (${label(s.defaultModel)})` : ''}
            </button>
            {MODEL_CHOICES.map((m) => (
              <button key={m} role="radio" aria-checked={s.model === m} className={s.model === m ? 'on' : ''} onClick={() => s.model !== m && void update('model', { model: m })}>
                {label(m)}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Claude session" hint="The terminal resumes this session." error={errors.session ?? busyNote}>
          <div className="folder-row">
            <code className="folder">{s.claudeSessionId ?? 'None — the next run starts a new session'}</code>
            <button
              className="btn small"
              disabled={s.taskActive || !s.claudeSessionId}
              onClick={() =>
                void api.resetSession(s.id).then(async (r) => {
                  if (!r.ok) return fail('session', r.detail);
                  clear('session');
                  setS(await api.getProjectSettings(s.id));
                })
              }
            >
              New Claude session
            </button>
          </div>
        </Row>
      </Section>

      <Section title="ChatGPT">
        <Row label="Conversation" hint="Paste a chatgpt.com conversation link, or reset to ChatGPT home." error={errors.chat}>
          <div className="folder-row">
            <input
              className="set-input"
              aria-label="ChatGPT conversation link"
              placeholder="ChatGPT home (no conversation)"
              value={chatLink}
              onChange={(e) => setChatLink(e.target.value)}
              onBlur={commitChatLink}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitChatLink();
              }}
            />
            <button className="btn small" disabled={!s.chatConversationUrl} onClick={() => void update('chat', { chatConversationUrl: null })}>
              Reset to ChatGPT Home
            </button>
          </div>
        </Row>
      </Section>

      <Section title="GitHub">
        <Row label="Repository" hint="owner/repo or a github.com link. Saved without signing in; verification is separate." error={errors.github}>
          <div className="folder-row">
            <input
              className="set-input"
              aria-label="GitHub repository"
              placeholder="AvvaMobile/AvvaMobile.Sidekick"
              value={repo}
              maxLength={200}
              onChange={(e) => setRepo(e.target.value)}
              onBlur={() => void commitRepo()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRepo();
              }}
            />
            <button className="btn small" disabled={!s.githubRepository || checking} onClick={() => void verifyGithub()}>
              Verify access
            </button>
          </div>
          {s.githubRepository &&
            (() => {
              const st = githubStatusText(s.githubAccess, checking);
              return (
                <div className={`github-status ${st.tone}`} role="status" aria-label="GitHub access status" title={s.githubAccess.checkedAt ? `Last checked ${new Date(s.githubAccess.checkedAt).toLocaleString()}` : undefined}>
                  {st.mark && `${st.mark} `}
                  {st.text}
                </div>
              );
            })()}
        </Row>
      </Section>

      <Section title="Danger zone" danger>
        <Row label="Close tab" hint="The project stays in Projects; its conversation and Claude session are kept." error={errors.danger}>
          <div>
            <button
              className="btn small"
              onClick={() =>
                void api.closeWorkspace(s.id).then((r) => {
                  if (!r.ok) fail('danger', r.detail);
                })
              }
            >
              Close Tab
            </button>
          </div>
        </Row>
        <Row label="Delete project" hint="Removes the project and its ChatGPT/Claude record from the app. Files on disk are not touched.">
          <div>
            <button
              className="btn small danger"
              onClick={() =>
                void api.removeWorkspace(s.id).then((r) => {
                  if (!r.ok && r.code !== 'cancelled') fail('danger', r.detail);
                })
              }
            >
              Delete Project…
            </button>
          </div>
        </Row>
      </Section>
    </SettingsPage>
  );
}
