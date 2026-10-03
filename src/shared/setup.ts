/** First-launch requirements popup (D037): what the app needs on this machine and where to get it. */

export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' | 'not-needed';

export interface ToolCheck {
  found: boolean;
  /** First line of `--version`, when found. */
  version: string | null;
}

export interface SetupCheck {
  claude: ToolCheck;
  git: ToolCheck;
  microphone: MicrophoneStatus;
}

export const SETUP_LINKS = {
  claude: 'https://code.claude.com/docs/en/setup',
  chatgpt: 'https://chatgpt.com',
  git: 'https://git-scm.com/downloads',
} as const;

export type SetupLink = keyof typeof SETUP_LINKS;

export const isSetupLink = (v: unknown): v is SetupLink => typeof v === 'string' && Object.hasOwn(SETUP_LINKS, v);
