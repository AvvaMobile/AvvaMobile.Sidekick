import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeRunRequest } from '../ClaudeRunner';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeTerminalPrompt } from '../../../domain/handoff/promptText';
import { InteractiveClaudeRunner, isSamePrompt } from '../InteractiveClaudeRunner';
import { StopHookChannel, lastAssistantText, parseHookPayload, parseStopPayload, type PromptSubmitEvent, type StopEvent } from '../StopHookChannel';

function setup(running = true, busy = false, prompt = 'do it', ackMs = 30_000) {
  const writes: string[] = [];
  let stop: (e: StopEvent) => void = () => {};
  let submitted: (e: PromptSubmitEvent) => void = () => {};
  let exit: () => void = () => {};
  let interrupt: () => void = () => {};
  let isBusy = busy;
  const idle = vi.fn();
  const runner = new InteractiveClaudeRunner(
    { isRunning: () => running, write: (_id, d) => void writes.push(d), onExit: (_id, cb) => ((exit = cb), () => {}) },
    {
      onStop: (_id, cb) => ((stop = cb), () => {}),
      onPromptSubmit: (_id, cb) => ((submitted = cb), () => {}),
      onInterrupt: (_id, cb) => ((interrupt = cb), () => {}),
      isBusy: () => isBusy,
      markIdle: idle,
    },
    () => null,
    ackMs,
  );
  const events: unknown[] = [];
  const exits: unknown[] = [];
  const req: ClaudeRunRequest = {
    taskId: 't', workspaceId: 'a', cwd: '/x', prompt, resumeSessionId: null,
    onEvent: (e) => events.push(e), onExit: (e) => exits.push(e),
  };
  return { runner, req, writes, events, exits, idle, stop: (e: StopEvent) => stop(e), submitted: (p: string | null) => submitted({ sessionId: 's1', prompt: p }), exit: () => exit(), interrupt: () => interrupt(), setBusy: (b: boolean) => void (isBusy = b) };
}

describe('InteractiveClaudeRunner', () => {
  afterEach(() => vi.useRealTimers());

  it('pastes the prompt, submits it and completes on the Stop hook', () => {
    vi.useFakeTimers();
    const t = setup();
    t.runner.start(t.req);
    expect(t.writes).toEqual(['\x1b[200~do it\x1b[201~']);
    vi.advanceTimersByTime(500);
    expect(t.writes[1]).toBe('\r');
    t.submitted('do it');
    t.stop({ sessionId: 's1', transcriptPath: null, lastAssistantMessage: 'Done.' });
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'result', result: 'Done.', sessionId: 's1', isError: false }));
    expect(t.exits).toEqual([{ code: 0, signal: null, spawnError: null }]);
  });

  it('fails when Claude is not running in the terminal', async () => {
    const t = setup(false);
    t.runner.start(t.req);
    await Promise.resolve();
    expect(t.writes).toEqual([]);
    expect(t.exits[0]).toMatchObject({ spawnError: expect.stringContaining('not running') });
  });

  it('fails when the terminal exits mid-task; cancel sends Escape once', () => {
    vi.useFakeTimers();
    const a = setup();
    a.runner.start(a.req);
    a.exit();
    expect(a.exits[0]).toMatchObject({ spawnError: expect.stringContaining('exited') });
    const b = setup();
    b.runner.start(b.req).cancel();
    expect(b.writes).toContain('\x1b');
    expect(b.exits).toEqual([{ code: null, signal: null, spawnError: null, cancelled: true }]);
    expect(b.idle).toHaveBeenCalledWith('a');
  });

  it('ignores a Stop of an earlier turn; completes only after Claude reported our prompt', () => {
    vi.useFakeTimers();
    const t = setup(true, false, 'Implement   the\nlogin screen');
    t.runner.start(t.req);
    t.stop({ sessionId: 's0', transcriptPath: null, lastAssistantMessage: 'old turn' });
    t.submitted('something the user typed');
    t.stop({ sessionId: 's0', transcriptPath: null, lastAssistantMessage: 'user turn' });
    expect(t.exits).toEqual([]);
    t.submitted('Implement the login screen');
    t.stop({ sessionId: 's1', transcriptPath: null, lastAssistantMessage: 'Done.' });
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'result', result: 'Done.' }));
    expect(t.exits).toEqual([{ code: 0, signal: null, spawnError: null }]);
  });

  it('accepts the next Stop when the UserPromptSubmit payload has no prompt', () => {
    vi.useFakeTimers();
    const t = setup();
    t.runner.start(t.req);
    t.submitted(null);
    t.stop({ sessionId: 's1', transcriptPath: null, lastAssistantMessage: 'Done.' });
    expect(t.exits).toHaveLength(1);
  });

  it('refuses to send while Claude is busy with another turn', async () => {
    const t = setup(true, true);
    t.runner.start(t.req);
    await Promise.resolve();
    expect(t.writes).toEqual([]);
    expect(t.exits[0]).toMatchObject({ spawnError: expect.stringContaining('still working in the terminal') });
  });

  it('a malicious prompt cannot leave the bracketed paste or inject keys', () => {
    vi.useFakeTimers();
    const evil = 'fix it\x1b[201~\x1b[Z\r!rm -rf ~\r\x9b201~\x07\x1b]0;title\x07done';
    const t = setup(true, false, evil);
    t.runner.start(t.req);
    const pasted = t.writes[0]!;
    expect(pasted.startsWith('\x1b[200~')).toBe(true);
    expect(pasted.endsWith('\x1b[201~')).toBe(true);
    const body = pasted.slice('\x1b[200~'.length, -'\x1b[201~'.length);
    expect(body).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(body).toBe('fix it\n!rm -rf ~\n201~done');
  });
});

describe('InteractiveClaudeRunner lifecycle: a run always ends', () => {
  afterEach(() => vi.useRealTimers());
  const stopEv = (text: string): StopEvent => ({ sessionId: 's1', transcriptPath: null, lastAssistantMessage: text });

  it('the user pressing Escape / Ctrl+C while the turn runs ends it as cancelled, with no result', () => {
    vi.useFakeTimers();
    const t = setup();
    t.runner.start(t.req);
    t.submitted('do it');
    t.interrupt();
    expect(t.exits).toEqual([{ code: null, signal: null, spawnError: null, cancelled: true }]);
    expect(t.events.filter((e) => (e as { type: string }).type === 'result')).toEqual([]);
    // the run is final: a late Stop or terminal exit cannot end it a second time
    t.stop(stopEv('late'));
    t.exit();
    expect(t.exits).toHaveLength(1);
  });

  it('an interrupt before Claude acknowledged the prompt (e.g. Escape clears the pasted text) also ends it', () => {
    vi.useFakeTimers();
    const t = setup();
    t.runner.start(t.req);
    t.interrupt();
    expect(t.exits).toEqual([expect.objectContaining({ cancelled: true })]);
  });

  it('a prompt that never reaches Claude fails once Claude has been idle for the acknowledgement time', () => {
    vi.useFakeTimers();
    const t = setup(true, false, 'do it', 1000);
    t.runner.start(t.req);
    vi.advanceTimersByTime(999);
    expect(t.exits).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(t.exits).toEqual([expect.objectContaining({ spawnError: expect.stringContaining('did not report receiving') })]);
  });

  it('the acknowledgement clock waits while Claude works on another turn (our prompt is queued behind it)', () => {
    vi.useFakeTimers();
    const t = setup(true, false, 'do it', 1000);
    t.runner.start(t.req);
    t.setBusy(true);
    vi.advanceTimersByTime(5000);
    expect(t.exits).toEqual([]);
    t.setBusy(false);
    vi.advanceTimersByTime(1100);
    expect(t.exits).toHaveLength(1);
  });

  it('an acknowledged prompt is never failed by the acknowledgement clock', () => {
    vi.useFakeTimers();
    const t = setup(true, false, 'do it', 1000);
    t.runner.start(t.req);
    t.submitted('do it');
    vi.advanceTimersByTime(60_000);
    expect(t.exits).toEqual([]);
    t.stop(stopEv('Done.'));
    expect(t.exits).toEqual([{ code: 0, signal: null, spawnError: null }]);
  });
});

describe('sanitizeTerminalPrompt', () => {
  it('keeps text, newlines and tabs; normalizes line endings; drops escape sequences and control characters', () => {
    expect(sanitizeTerminalPrompt('a\tb\r\nc\rd\n')).toBe('a\tb\nc\nd\n');
    expect(sanitizeTerminalPrompt('x\x1b[201~y\x1b[Zz\x1bOPw\x1b\\v\x1b')).toBe('xyzwv');
    expect(sanitizeTerminalPrompt('\x1bP1$r\x1b\\ok\x1b]52;c;aGk=\x07!')).toBe('ok!');
    expect(sanitizeTerminalPrompt('Türkçe ✓ `code`')).toBe('Türkçe ✓ `code`');
  });
});

describe('isSamePrompt', () => {
  it('matches normalized whitespace and truncated prompts, not other prompts', () => {
    expect(isSamePrompt('a  b\n c', 'a b c')).toBe(true);
    expect(isSamePrompt('x'.repeat(300), 'x'.repeat(5000))).toBe(true);
    expect(isSamePrompt('[Pasted text #1 +40 lines]', 'long prompt')).toBe(true);
    expect(isSamePrompt('ls', 'Implement the login screen')).toBe(false);
  });
});

describe('StopHookChannel', () => {
  it('interrupt clears the busy mark and tells only that Workspace\'s listeners', () => {
    const ch = new StopHookChannel(mkdtempSync(join(tmpdir(), 'hooks-')));
    const a = vi.fn();
    const b = vi.fn();
    ch.onInterrupt('a', a);
    ch.onInterrupt('b', b);
    ch.dispatch('a', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }), 'prompt');
    expect(ch.isBusy('a')).toBe(true);
    ch.interrupt('a');
    expect(ch.isBusy('a')).toBe(false);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('tracks a turn in progress between UserPromptSubmit and Stop', () => {
    const ch = new StopHookChannel(mkdtempSync(join(tmpdir(), 'hooks-')));
    const prompts: PromptSubmitEvent[] = [];
    const stops: StopEvent[] = [];
    ch.onPromptSubmit('a', (e) => prompts.push(e));
    ch.onStop('a', (e) => stops.push(e));
    ch.dispatch('a', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' }));
    expect(ch.isBusy('a')).toBe(true);
    expect(ch.isBusy('b')).toBe(false);
    ch.dispatch('a', JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), 'prompt');
    expect(ch.isBusy('a')).toBe(false);
    // Without hook_event_name the event file's name decides.
    ch.dispatch('a', '{"session_id":"s"}', 'prompt');
    expect(ch.isBusy('a')).toBe(true);
    ch.markIdle('a');
    expect(ch.isBusy('a')).toBe(false);
    expect(prompts).toEqual([{ sessionId: 's', prompt: 'hi' }, { sessionId: 's', prompt: null }]);
    expect(stops).toHaveLength(1);
    expect(parseHookPayload('{"hook_event_name":"UserPromptSubmit"}')).toEqual({ kind: 'prompt', event: { sessionId: null, prompt: null } });
  });
});

describe('Stop hook payload', () => {
  it('parses the hook JSON and reads the last assistant turn from a transcript', () => {
    expect(parseStopPayload('{"session_id":"s","transcript_path":"/t","last_assistant_message":"hi"}')).toEqual({ sessionId: 's', transcriptPath: '/t', lastAssistantMessage: 'hi' });
    expect(parseStopPayload('nope')).toBeNull();
    const jsonl = [
      { type: 'user', message: { content: 'p1' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'old' }] } },
      { type: 'user', message: { content: 'p2' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'final' }] } },
    ].map((l) => JSON.stringify(l)).join('\n');
    expect(lastAssistantText(jsonl)).toBe('final');
  });
});
