/** Pi reports null usage after compaction until the next measured model response. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export const AUTO_COMPACT_PERCENT = 90;
export function needsCompaction(usage: ContextUsage | undefined): boolean {
  return !!usage && usage.tokens !== null && usage.contextWindow > 0 &&
    usage.tokens * 100 >= usage.contextWindow * AUTO_COMPACT_PERCENT;
}
