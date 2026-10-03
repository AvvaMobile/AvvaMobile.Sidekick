import { describe, expect, it } from 'vitest';
import { isPermutation } from '../order';

describe('sidebar order', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('accepts only exact permutations', () => {
    expect(isPermutation(ids, ['d', 'c', 'b', 'a'])).toBe(true);
    expect(isPermutation(ids, ['a', 'b', 'c'])).toBe(false);
    expect(isPermutation(ids, ['a', 'a', 'b', 'c'])).toBe(false);
    expect(isPermutation(ids, ['a', 'b', 'c', 'x'])).toBe(false);
    expect(isPermutation(ids, ['a', 'b', 'c', 4])).toBe(false);
  });
});
