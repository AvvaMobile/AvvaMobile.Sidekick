import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MicrophoneStatus, SetupCheck, SetupLink } from '../../../shared/setup';
import type { WorkspaceApi } from '../api';

interface Props {
  api: Pick<WorkspaceApi, 'checkSetup' | 'openSetupLink' | 'requestMicrophone'>;
  /** ChatGPT sign-in as reported by the open Workspaces: true if any is signed in, null when unknown. */
  chatgptLoggedIn: boolean | null;
  onClose(): void;
}

type Status = 'ok' | 'missing' | 'unknown' | 'checking';

interface Row {
  key: SetupLink | 'microphone';
  title: string;
  icon: ReactNode;
  status: Status;
  /** Right-hand text when there is no action to take. */
  state: string;
  /** What it is for / what to do, under the title. */
  detail: string;
  action: { label: string; run(): void; primary?: boolean } | null;
}

const svg = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);
const ICONS = {
  claude: svg(<><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" /></>),
  chatgpt: svg(<path d="M20 11.5c0 4-3.6 7-8 7-1.2 0-2.3-.2-3.3-.6L4 19.5l1.3-3.6C4.5 14.6 4 13.1 4 11.5c0-4 3.6-7 8-7s8 3 8 7Z" />),
  git: svg(<><circle cx="6.5" cy="6" r="2" /><circle cx="6.5" cy="18" r="2" /><circle cx="17.5" cy="9" r="2" /><path d="M6.5 8v8M17.5 11c0 3-4 3-9.5 5.5" /></>),
  microphone: svg(<><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></>),
  sidekick: svg(<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5M10.5 6.5 5 12l5.5 5.5" />),
};

/** "2.1.288 (Claude Code)" → "v2.1.288", "git version 2.50.1 (Apple Git-155)" → "v2.50.1". */
const shortVersion = (v: string | null): string | null => {
  const m = v?.match(/\d+\.\d+(?:\.\d+)?/);
  return m ? `v${m[0]}` : v;
};

/** Requirements popup (D037): shown on first launch, and from Help → Setup Checklist…. */
export function SetupDialog({ api, chatgptLoggedIn, onClose }: Props) {
  const [check, setCheck] = useState<SetupCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [mic, setMic] = useState<MicrophoneStatus | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const result = await api.checkSetup();
      setCheck(result);
      setMic(result.microphone);
    } finally {
      setChecking(false);
    }
  }, [api]);

  // Checks as soon as it opens; "Check again" re-runs it after the user installed something.
  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const tool = (found: boolean | undefined): Status => (checking || found === undefined ? 'checking' : found ? 'ok' : 'missing');
  const download = (key: SetupLink) => ({ label: 'Download', run: () => void api.openSetupLink(key) });

  const claude = tool(check?.claude.found);
  const git = tool(check?.git.found);
  const chatgpt: Status = chatgptLoggedIn === null ? 'unknown' : chatgptLoggedIn ? 'ok' : 'missing';
  const rows: Row[] = [
    {
      key: 'claude',
      title: 'Claude Code',
      icon: ICONS.claude,
      status: claude,
      state: shortVersion(check?.claude.version ?? null) ?? 'Installed',
      detail: claude === 'missing' ? 'Install it, then run claude once in a terminal to sign in.' : 'Writes the code in your project folder.',
      action: claude === 'missing' ? download('claude') : null,
    },
    {
      key: 'chatgpt',
      title: 'ChatGPT account',
      icon: ICONS.chatgpt,
      status: chatgpt,
      state: 'Signed in',
      detail: chatgpt === 'ok' ? 'Plans the work with you.' : 'Sign in once inside a project.',
      action: chatgpt === 'ok' ? null : { label: 'Get an account', run: () => void api.openSetupLink('chatgpt') },
    },
    {
      key: 'git',
      title: 'Git',
      icon: ICONS.git,
      status: git,
      state: shortVersion(check?.git.version ?? null) ?? 'Installed',
      detail: 'Shows what Claude changed when it finishes.',
      action: git === 'missing' ? download('git') : null,
    },
  ];
  if (mic !== null && mic !== 'not-needed') {
    const blocked = mic === 'denied' || mic === 'restricted';
    rows.push({
      key: 'microphone',
      title: 'Microphone',
      icon: ICONS.microphone,
      status: mic === 'granted' ? 'ok' : blocked ? 'missing' : 'unknown',
      state: 'Allowed',
      detail: blocked ? 'Blocked. Turn it on in System Settings to talk to ChatGPT.' : 'Lets you talk to ChatGPT by voice.',
      action: mic === 'granted' ? null : { label: blocked ? 'Open Settings' : 'Allow', run: () => void api.requestMicrophone().then(setMic), primary: !blocked },
    });
  }

  const ready = rows.filter((r) => r.status === 'ok').length;
  const allReady = ready === rows.length;

  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal setup-modal" role="dialog" aria-label="Before you start">
        <div className="setup-flow" aria-hidden="true">
          <span className={`flow-node ${chatgpt === 'ok' ? 'on' : ''}`}>{ICONS.chatgpt}<small>ChatGPT</small></span>
          <span className={`flow-link ${chatgpt === 'ok' ? 'on' : ''}`} />
          <span className="flow-node hub on">{ICONS.sidekick}<small>Sidekick</small></span>
          <span className={`flow-link ${claude === 'ok' ? 'on' : ''}`} />
          <span className={`flow-node ${claude === 'ok' ? 'on' : ''}`}>{ICONS.claude}<small>Claude Code</small></span>
        </div>

        <h2>{allReady ? 'You’re all set' : 'Before you start'}</h2>
        <p className="setup-lede">You plan with ChatGPT, Sidekick hands the prompt to Claude Code, and Claude writes the code on this computer.</p>

        <ul className="setup-list">
          {rows.map((r) => (
            <li key={r.key} className={`setup-row ${r.status}`}>
              <span className="setup-icon">{r.icon}</span>
              <div className="setup-text">
                <b>{r.title}</b>
                <span>{r.detail}</span>
              </div>
              {r.action ? (
                <button className={`btn small ${r.action.primary ? 'primary' : ''}`} onClick={r.action.run}>
                  {r.action.label}
                </button>
              ) : (
                <span className="setup-state">{r.status === 'checking' ? 'Checking…' : r.state}</span>
              )}
              <span className={`setup-status ${r.status}`} aria-label={r.status} />
            </li>
          ))}
        </ul>

        <div className="setup-footer">
          <span className="setup-count">
            {ready} of {rows.length} ready
          </span>
          <button className="btn ghost" onClick={() => void runCheck()} disabled={checking}>
            Check again
          </button>
          <button className="btn primary" autoFocus onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
