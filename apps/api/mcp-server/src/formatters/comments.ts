/**
 * Text formatter for comment list results.
 * Converts verbose JSON into compact agent-readable text.
 */

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

export function formatCommentList(data: any): string {
  const lines: string[] = [];
  const comments = data.comments || [];
  const pagination = data.pagination;
  const total = pagination?.total_count ?? comments.length;

  lines.push(`# Comments (${total} total)`);
  lines.push('');

  if (comments.length === 0) {
    lines.push('No comments found.');
    return lines.join('\n');
  }

  const offset = pagination?.offset ?? 0;
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const author = c.author || 'anonymous';
    const date = formatDate(c.created_at);
    const status = c.status || 'active';
    const replyTag = c.parent_comment_id ? ' (reply)' : '';

    const cId = c.id ? ` ${c.id}` : '';
    lines.push(`${offset + i + 1}. [${status}]${cId} ${author} (${date}): "${truncate(c.content, 120)}"${replyTag}`);

    if (c.anchor_text) {
      lines.push(`   Anchored to: "${truncate(c.anchor_text, 80)}"`);
    }

    if (i < comments.length - 1) lines.push('');
  }

  // Pagination
  if (pagination?.has_more) {
    const limit = pagination.limit || 20;
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit);
    lines.push('');
    lines.push(`Page ${page} of ${totalPages} (${limit} per page)`);
  }

  return lines.join('\n').trimEnd();
}

export function formatComment(data: any): string {
  const lines: string[] = [];
  const c = data.comment || data;

  const author = c.author || 'anonymous';
  const status = c.status || 'active';
  const date = formatDate(c.created_at);
  const replyTag = c.parent_comment_id ? ' (reply)' : '';

  const cId = c.id || '';
  lines.push(`# Comment [${status}]${replyTag}`);
  lines.push(`ID: ${cId} | Author: ${author} | Created: ${date}`);
  lines.push('');
  lines.push(c.content || '(empty)');

  if (c.anchor_text) {
    lines.push('');
    lines.push(`Anchored to: "${truncate(c.anchor_text, 200)}"`);
  }

  return lines.join('\n').trimEnd();
}
