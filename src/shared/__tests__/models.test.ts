import { describe, expect, it } from 'vitest';
import { isEffortChoice, isModelChoice, parseDefaultModel } from '../models';

describe('models', () => {
  it('reads the default model from settings.json', () => {
    expect(parseDefaultModel('{"model":"opus"}')).toBe('opus');
    expect(parseDefaultModel('{"model":"claude-sonnet-5-5"}')).toBe('sonnet');
    expect(parseDefaultModel('{"model":"opus[1m]"}')).toBe('opus');
    expect(parseDefaultModel('{"model":"haiku"}')).toBeNull();
    expect(parseDefaultModel('{}')).toBeNull();
    expect(parseDefaultModel('not json')).toBeNull();
  });
  it('validates choices', () => {
    expect(isModelChoice('fable')).toBe(true);
    expect(isModelChoice('gpt')).toBe(false);
    expect(isEffortChoice('xhigh')).toBe(true);
    expect(isEffortChoice('extreme')).toBe(false);
    expect(isEffortChoice(null)).toBe(false);
  });
});
