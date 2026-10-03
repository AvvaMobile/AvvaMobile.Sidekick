/** True when `next` is a reordering of exactly the ids in `current` (no additions, removals or duplicates). */
export function isPermutation(current: readonly string[], next: readonly unknown[]): next is string[] {
  if (next.length !== current.length || new Set(next).size !== next.length) return false;
  const known = new Set(current);
  return next.every((x) => typeof x === 'string' && known.has(x));
}
