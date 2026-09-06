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
  const out: string[] = [];
  if (meta?.error) out.push('[错误]');
  out.push(text);

  const head: string[] = [];
  if (meta?.tool) head.push(meta.tool);
  if (meta?.duration) {
    const sec = meta.duration / 1000;
    head.push(sec >= 60 ? `${(sec / 60).toFixed(1)}min` : `${sec.toFixed(1)}s`);
  }
  const usage = meta?.usage;
  const hasUsage =
    !!usage && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens || usage.cacheWriteTokens);

  if (head.length || hasUsage) out.push('');
  // Per-run token usage sits between the body and the tool/time line, which
  // stays on the very last row (reads like a signature/timestamp). Chinese
  // labels carry the unit in the heading, and the cache line is explicitly
  // THIS run, distinct from /context's cumulative rate.
  if (hasUsage) {
    const u = usage!;
    out.push(
      `本轮 token：输入 ${formatTokens(u.inputTokens ?? 0)} · 输出 ${formatTokens(u.outputTokens ?? 0)}`,
    );
    const hit = cacheHitRate(u);
    if (hit !== null) out.push(`本轮缓存命中：${hit}%`);
  }
  if (head.length > 0) out.push(`— ${head.join(' | ')}`);

  return out.join('\n');
}
