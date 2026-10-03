import type { FlowEntry } from '../../shared/state';

/** Entries kept per Workspace (newest last). */
export const FLOW_LOG_LIMIT = 40;

/** Appends an entry (newest last), dropping the oldest beyond the limit. Returns the new log. */
export function appendFlow(log: readonly FlowEntry[] | undefined, entry: Omit<FlowEntry, 'seq'>): FlowEntry[] {
  const next = [...(log ?? []), { ...entry, seq: (log?.[log.length - 1]?.seq ?? 0) + 1 }];
  return next.length > FLOW_LOG_LIMIT ? next.slice(next.length - FLOW_LOG_LIMIT) : next;
}
