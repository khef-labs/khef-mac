/**
 * Text formatters for assistant chat tools:
 * assistant_chat, list_assistant_chats, get_assistant_chat
 */

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  return dateStr.substring(0, 10);
}

function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  const clean = s.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen - 3) + '...';
}

export function formatChatResponse(data: any): string {
  const lines: string[] = [];
  const msg = data.message || {};

  lines.push(`# Chat Response`);
  lines.push(`Chat: ${data.chat_id || ''} | Turn: ${data.turn_id || msg.id || ''}`);
  if (data.session_id) lines.push(`Session: ${data.session_id}`);
  lines.push('');

  if (msg.response) {
    lines.push(msg.response);
  } else if (typeof data.response === 'string') {
    lines.push(data.response);
  }

  // Render thinking metadata if present
  const thinking = msg.thinking || data.thinking;
  if (thinking) {
    lines.push('');
    lines.push('---');
    lines.push(`**Thinking** (${thinking.tokenCount ?? '?'} tokens)`);
    if (thinking.text) {
      lines.push(thinking.text);
    }
  }

  // Render grounding sources if present
  const grounding = msg.grounding || data.grounding;
  if (grounding) {
    lines.push('');
    lines.push('---');
    lines.push('**Sources**');
    if (grounding.sources && grounding.sources.length > 0) {
      for (const src of grounding.sources) {
        lines.push(`- [${src.title}](${src.uri})`);
      }
    }
    if (grounding.searchQueries && grounding.searchQueries.length > 0) {
      lines.push(`Queries: ${grounding.searchQueries.join(', ')}`);
    }
  }

  // Render URL context fetches if present (Gemini url_context tool)
  const urlContext = data.url_context || msg.url_context;
  if (urlContext && Array.isArray(urlContext.fetched) && urlContext.fetched.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('**URL Context (fetched)**');
    for (const f of urlContext.fetched) {
      lines.push(`- ${f.url} — ${f.status}`);
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatChatList(data: any): string {
  const lines: string[] = [];
  const chats = data.chats || [];
  const pagination = data.pagination;

  const total = pagination?.total_count ?? chats.length;
  lines.push(`# Chats (${total})`);
  lines.push('');

  if (chats.length === 0) {
    lines.push('No chats found.');
    return lines.join('\n');
  }

  for (const c of chats) {
    const title = c.title || '(untitled)';
    const assistant = c.assistant_handle || '';
    const messages = c.message_count ?? '?';
    const project = c.project_handle ? ` [${c.project_handle}]` : '';
    lines.push(`- **${title}** (${assistant}, ${messages} msgs)${project}`);
    lines.push(`  ID: ${c.id} | Updated: ${formatDate(c.updated_at)}`);
  }

  if (pagination?.has_more) {
    lines.push('');
    lines.push(`Showing ${chats.length} of ${total}. Use offset for next page.`);
  }

  return lines.join('\n').trimEnd();
}

export function formatChat(data: any): string {
  const lines: string[] = [];
  const chat = data.chat || data;

  const title = chat.title || '(untitled)';
  const assistant = chat.assistant_handle || '';
  lines.push(`# ${title}`);
  lines.push(`ID: ${chat.id} | Assistant: ${assistant} | Updated: ${formatDate(chat.updated_at)}`);
  if (chat.project_handle) lines.push(`Project: ${chat.project_handle}`);
  lines.push('');

  const messages = data.messages || chat.messages || [];
  if (messages.length > 0) {
    lines.push(`## Messages (${messages.length})`);
    lines.push('');
    for (const msg of messages) {
      const date = formatDate(msg.created_at);
      const model = msg.model && msg.model !== 'unknown' ? ` (${msg.model})` : '';
      const tokens = msg.input_tokens || msg.output_tokens
        ? ` | ${msg.input_tokens ?? '?'}→${msg.output_tokens ?? '?'} tokens`
        : '';

      if (msg.prompt_text) {
        lines.push(`**user** (${date})`);
        lines.push(truncate(msg.prompt_text, 300));
        lines.push('');
      }

      if (msg.response) {
        lines.push(`**assistant**${model}${tokens}`);
        lines.push(msg.response);
        lines.push('');
      } else if (msg.error) {
        lines.push(`**error**${model}`);
        lines.push(msg.error);
        lines.push('');
      } else if (msg.status === 'pending') {
        lines.push(`*pending...*`);
        lines.push('');
      }
    }
  }

  return lines.join('\n').trimEnd();
}
