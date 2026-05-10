/**
 * Text formatter for active session results.
 * Converts verbose JSON into compact agent-readable text.
 */

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 16).replace('T', ' ');
}

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

export function formatActiveSessionsList(data: any): string {
  const lines: string[] = [];
  const sessions = data.sessions || [];
  const count = data.count ?? sessions.length;

  lines.push(`# Active Sessions (${count})`);
  lines.push('');

  if (sessions.length === 0) {
    lines.push('No active sessions found.');
    return lines.join('\n');
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const nickname = s.nickname ? `(${s.nickname}) ` : '';
    const project = s.project?.handle ? `[${s.project.handle}]` : '[no project]';
    const pid = s.pid ? `PID ${s.pid}` : 'no PID';
    const liveCount = s.live_message_count > 0 ? ` | ${s.live_message_count} live msg${s.live_message_count !== 1 ? 's' : ''}` : '';
    lines.push(`${i + 1}. ${nickname}${project} ${pid}${liveCount}`);
    lines.push(`   ID: ${s.session_id}`);

    const meta: string[] = [];
    if (s.last_seen_at) meta.push(`Last seen: ${formatDate(s.last_seen_at)}`);
    if (s.first_seen_at) meta.push(`Since: ${formatDate(s.first_seen_at)}`);
    if (meta.length) lines.push(`   ${meta.join(' | ')}`);

    if (s.transcript) {
      const msgs = s.transcript.message_count != null ? `${s.transcript.message_count} msgs` : '';
      const summary = s.transcript.summary ? truncate(s.transcript.summary, 100) : '';
      const parts: string[] = [];
      if (msgs) parts.push(msgs);
      if (s.transcript.name) parts.push(s.transcript.name);
      if (parts.length) lines.push(`   Transcript: ${parts.join(' | ')}`);
      if (summary) lines.push(`   ${summary}`);
    }

    if (i < sessions.length - 1) lines.push('');
  }

  lines.push('');
  lines.push('Tip: Use send_live_message(to_session_id) to message a session, or get_current_session() for your current session.');

  return lines.join('\n').trimEnd();
}

export function formatCurrentSession(data: any): string {
  const lines: string[] = [];
  const s = data.session || data;

  const nickname = s.nickname ? ` (${s.nickname})` : '';
  const status = s.status || 'unknown';
  lines.push(`# Session: ${s.session_id}${nickname}`);
  lines.push(`Status: ${status}`);

  if (s.project) {
    lines.push(`Project: ${s.project.handle || s.project.name} (${s.project.id})`);
  }

  lines.push(`Assistant: ${s.assistant?.handle || s.assistant?.name || 'unknown'}`);

  const meta: string[] = [];
  if (s.pid) meta.push(`PID: ${s.pid}`);
  if (s.last_seen_at) meta.push(`Last seen: ${formatDate(s.last_seen_at)}`);
  if (s.first_seen_at) meta.push(`Since: ${formatDate(s.first_seen_at)}`);
  if (meta.length) lines.push(meta.join(' | '));

  if (s.transcript) {
    lines.push('');
    lines.push('## Transcript');
    const parts: string[] = [];
    if (s.transcript.name) parts.push(s.transcript.name);
    if (s.transcript.message_count != null) parts.push(`${s.transcript.message_count} msgs`);
    if (s.transcript.started_at) parts.push(`Started: ${formatDate(s.transcript.started_at)}`);
    if (s.transcript.ended_at) parts.push(`Ended: ${formatDate(s.transcript.ended_at)}`);
    if (parts.length) lines.push(parts.join(' | '));
    if (s.transcript.summary) {
      lines.push('');
      lines.push(s.transcript.summary);
    }
  }

  if (s.file_path) {
    lines.push('');
    lines.push(`File: ${s.file_path}`);
  }

  return lines.join('\n').trimEnd();
}
