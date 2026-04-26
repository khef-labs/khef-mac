/**
 * Text formatter for kdag job error records from Redis cache.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 16).replace('T', ' ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

export function formatJobErrors(data: any): string {
  const errors = data.errors || [];
  const lines: string[] = [];

  lines.push(`# Recent Job Errors (${errors.length})`);
  lines.push('');

  if (errors.length === 0) {
    lines.push('No recent job errors cached in Redis.');
    lines.push('Errors are stored when kdag jobs fail and expire after 3 days.');
    return lines.join('\n');
  }

  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    lines.push(`${i + 1}. **${e.definitionKey}** — ${e.stepName} (\`${e.stepKey}\`)`);
    lines.push(`   Job: ${e.jobId}`);
    lines.push(`   Run: ${e.runId}`);
    if (e.backend || e.model) {
      const parts = [e.backend, e.model].filter(Boolean).join(' / ');
      lines.push(`   Backend: ${parts}`);
    }
    if (e.durationMs !== undefined) {
      lines.push(`   Duration: ${(e.durationMs / 1000).toFixed(1)}s`);
    }
    lines.push(`   Time: ${formatDate(e.timestamp)}`);
    lines.push(`   Error: ${truncate(e.error, 300)}`);
    if (i < errors.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatJobErrorsCleared(data: any): string {
  const cleared = data.cleared ?? 0;
  if (cleared === 0) return 'No cached job errors to clear.';
  return `Cleared ${cleared} cached job error${cleared !== 1 ? 's' : ''}.`;
}
