/**
 * Text formatter for live (ephemeral) message results.
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 16).replace('T', ' ');
}

export function formatLiveMessageSent(data: any): string {
  // Broadcast response: { messages: [...], recipients: N }
  if (data.messages && Array.isArray(data.messages)) {
    const count = data.recipients || data.messages.length;
    const lines = data.messages.map((m: any) =>
      `- ${m.to_session_id} (ID: ${m.id})`
    );
    return `Live message broadcast to ${count} session${count !== 1 ? 's' : ''}:\n${lines.join('\n')}\nSent: ${formatDate(data.messages[0]?.created_at)}`;
  }
  // Single message response (legacy)
  const m = data.message || data;
  return `Live message sent to ${m.to_session_id}\nID: ${m.id} | Sent: ${formatDate(m.created_at)}`;
}

export function formatLiveInbox(data: any): string {
  const messages = data.messages || [];
  const lines: string[] = [];

  lines.push(`# Live Inbox (${messages.length} message${messages.length !== 1 ? 's' : ''})`);
  lines.push('');

  if (messages.length === 0) {
    lines.push('No live messages.');
    return lines.join('\n');
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    lines.push(`${i + 1}. ${m.id}`);
    lines.push(`   From: ${m.from_session_id}`);
    lines.push(`   Sent: ${formatDate(m.created_at)}`);
    lines.push(`   ${m.content || ''}`);
    if (i < messages.length - 1) lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function formatLiveMessageDeleted(data: any): string {
  if (!data.deleted) {
    return 'Message not found or not owned by you.';
  }
  const m = data.message || {};
  return `Message deleted from ${m.to_session_id || 'recipient'}\nID: ${m.id} | Originally sent: ${formatDate(m.created_at)}`;
}

export function formatLiveCount(data: any): string {
  const count = data.count ?? 0;
  if (count === 0) return 'No pending live messages.';
  return `${count} pending live message${count !== 1 ? 's' : ''}.`;
}
