/**
 * Text formatter for agent question results.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 16).replace('T', ' ');
}

function summarizeField(field: any): string {
  const required = field.required ? ' *' : '';
  const optionStr =
    field.options && Array.isArray(field.options)
      ? ` (${field.options.map((o: any) => o.value).join(' | ')})`
      : '';
  return `- ${field.key}${required}: ${field.type}${optionStr} — ${field.label}`;
}

export function formatQuestionCreated(data: any): string {
  const q = data.question || data;
  const lines: string[] = [];
  lines.push(`Posted question ${q.id}`);
  lines.push(`Title: ${q.title}`);
  lines.push(`Expires: ${formatDate(q.expires_at)} (status: ${q.status})`);
  if (q.fields?.length) {
    lines.push('Fields:');
    for (const f of q.fields) lines.push(`  ${summarizeField(f)}`);
  }
  const hasRecipient = q.agent?.nickname || q.agent?.session_id;
  lines.push('');
  if (hasRecipient) {
    lines.push('The answer will be delivered to your session as a live message when the user submits.');
    lines.push('Continue your other work — you will be notified automatically.');
  } else {
    lines.push('Warning: no nickname/session_id was provided, so the answer cannot be delivered as a live message.');
    lines.push('Call get_user_answer with the question id to retrieve the answer.');
  }
  return lines.join('\n');
}

export function formatAnswer(result: any, questionId: string): string {
  if (result?.status === 'expired') {
    return `Question ${questionId} expired before the user answered.`;
  }
  if (result?.status === 'canceled') {
    return `Question ${questionId} was canceled.`;
  }
  const ans = result?.answer ?? null;
  if (!ans) {
    return `Question ${questionId}: no answer yet.`;
  }
  const lines: string[] = [];
  lines.push(`Answer to ${questionId}`);
  lines.push(`Answered: ${formatDate(ans.answered_at)}`);
  lines.push('Values:');
  const values = ans.values ?? {};
  for (const [k, v] of Object.entries(values)) {
    const s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    lines.push(`  ${k}: ${s}`);
  }
  return lines.join('\n');
}

export function formatPendingList(data: any): string {
  const questions = data.questions || [];
  const lines: string[] = [];
  lines.push(`# Pending agent questions (${questions.length})`);
  lines.push('');
  if (questions.length === 0) {
    lines.push('No pending questions.');
    return lines.join('\n');
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const nick = q.agent?.nickname ? ` [${q.agent.nickname}]` : '';
    lines.push(`${i + 1}. ${q.id}${nick}`);
    lines.push(`   ${q.title}`);
    lines.push(`   Expires: ${formatDate(q.expires_at)} | Fields: ${q.fields?.length ?? 0}`);
    if (i < questions.length - 1) lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatCanceled(id: string, ok: boolean): string {
  return ok ? `Canceled question ${id}.` : `Could not cancel question ${id}.`;
}
