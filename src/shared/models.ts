/** Claude models offered by the shortcut in the development pane (passed to Claude Code as `--model <alias>`). */
export const MODEL_CHOICES = ['opus', 'sonnet', 'fable'] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

export const isModelChoice = (v: unknown): v is ModelChoice => typeof v === 'string' && (MODEL_CHOICES as readonly string[]).includes(v);

/** The model Claude Code uses without `--model`: `model` in the user's settings.json, when it is one of the three choices. */
export function parseDefaultModel(settingsJson: string): ModelChoice | null {
  try {
    const m = (JSON.parse(settingsJson) as { model?: unknown }).model;
    if (typeof m !== 'string') return null;
    const v = m.trim().toLowerCase();
    return MODEL_CHOICES.find((c) => v === c || v.startsWith(`${c}[`) || v.includes(c)) ?? null;
  } catch {
    return null;
  }
}
