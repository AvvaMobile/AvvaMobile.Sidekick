import { describe, expect, it } from 'vitest';
import { composeClaudePrompt, DEFAULT_PROMPT_SUFFIX } from '../promptSuffix';

describe('composeClaudePrompt', () => {
  it('joins prompt, one blank line, suffix', () => expect(composeClaudePrompt('P', 'S')).toBe('P\n\nS'));
  it('adds nothing for empty, blank or missing suffix', () => {
    for (const s of ['', '  \n ', null, undefined]) expect(composeClaudePrompt('P', s)).toBe('P');
  });
  it('strips terminal escape sequences from the suffix', () => expect(composeClaudePrompt('P', 'a\x1b[201~b')).toBe('P\n\nab'));
  it('default is the two numbered rules', () => expect(DEFAULT_PROMPT_SUFFIX.split('\n')).toHaveLength(2));
});
