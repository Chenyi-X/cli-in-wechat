export interface ResponseMeta {
  tool?: string;
  duration?: number;
  error?: boolean;
  /** Per-run token usage (M8). When present, the footer appends an
   *  in/out/cache-hit line. Only filled by adapters that can report usage. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** Compact token count: 1234 -> "1.2k", 2_400_000 -> "2.4M". */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** Cache hit rate = cacheRead / (cacheRead + cacheWrite + input). The write term
 *  is in the denominator because freshly-written cache tokens are also billed —
 *  omitting it would overstate how much sending was actually cached. */
export function cacheHitRate(usage: NonNullable<ResponseMeta['usage']>): number | null {
  const { inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0 } = usage;
  const sent = cacheReadTokens + cacheWriteTokens + inputTokens;
  if (sent <= 0) return null;
  return Math.round((cacheReadTokens / sent) * 100);
}

export function formatResponse(text: string, meta?: ResponseMeta): string {
  const parts: string[] = [];
  if (meta?.error) parts.push('[错误]');
  parts.push(text);

  const footer: string[] = [];
  if (meta?.tool) footer.push(meta.tool);
  if (meta?.duration) {
    const sec = meta.duration / 1000;
    footer.push(sec >= 60 ? `${(sec / 60).toFixed(1)}min` : `${sec.toFixed(1)}s`);
  }
  const usage = meta?.usage;
  if (usage && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens)) {
    const hit = cacheHitRate(usage);
    footer.push(
      `in ${formatTokens(usage.inputTokens ?? 0)} · out ${formatTokens(usage.outputTokens ?? 0)}` +
        (hit !== null ? ` · cache ${hit}%` : ''),
    );
  }
  if (footer.length > 0) parts.push(`\n— ${footer.join(' | ')}`);

  return parts.join('\n');
}
