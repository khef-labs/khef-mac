#!/usr/bin/env tsx
/**
 * Kdag code step: Fetch session content for summarization.
 *
 * Input (stdin): JSON with session_id field (file UUID or DB row ID)
 * Output (stdout): Session transcript or existing summaries, depending on size.
 *
 * Strategy:
 * - If a session summary already exists, output it with a note
 * - If transcript is under the threshold, output raw chunks
 * - If transcript is large, fetch compaction summaries instead
 *   (like get_session_lineage but for a single session)
 */

const API_URL = process.env.KHEF_API_URL || 'http://localhost:3201';

// If transcript exceeds this, prefer summaries/compactions over raw content
const LARGE_SESSION_CHARS = 100_000;

interface Session {
  id: string;
  session_id: string;
  nickname?: string;
  summary?: string;
  message_count?: number;
  content?: string;
  chunks?: Array<{ content: string; chunk_index: number }>;
}

interface SummaryData {
  summary?: { id: string; content: string };
  compactions?: Array<{ id: string; content: string; message_index: number }>;
}

async function api(path: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const cleaned = input.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Input may be a plain UUID string or JSON with session_id field
    let sessionId: string;
    try {
      const data = JSON.parse(cleaned);
      sessionId = data.session_id || data;
    } catch {
      // Plain text — treat as the session ID directly
      sessionId = cleaned;
    }

    if (!sessionId) {
      console.error('Missing session_id in input');
      process.exit(1);
    }

    // 1. Fetch session metadata
    const sessionData = await api(`/api/sessions/${sessionId}`);
    const session: Session = sessionData.session;

    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    const dbId = session.id;
    const nickname = session.nickname || 'unknown';
    const header = `# Session: ${nickname} (${session.session_id})\n\n`;

    // 2. Check for existing summary + compactions
    let summaryData: SummaryData | null = null;
    try {
      const sd = await api(`/api/sessions/${dbId}/summary`);
      summaryData = sd;
    } catch {
      // No summary exists — that's fine
    }

    const hasCompactions = summaryData?.compactions && summaryData.compactions.length > 0;
    const hasSummary = summaryData?.summary?.content;

    // 3. Fetch transcript chunks to measure size
    const chunkedData = await api(`/api/sessions/${sessionId}?include_chunks=true`);
    const chunks = chunkedData.chunks || [];
    const totalChars = chunks.reduce((sum: number, c: any) => sum + (c.content?.length || 0), 0);

    console.error(`Session ${nickname}: ${chunks.length} chunks, ${totalChars} chars, ${hasCompactions ? 'has' : 'no'} compactions, ${hasSummary ? 'has' : 'no'} summary`);

    // 4. Assemble content chronologically
    //
    // Each compaction or AI summary replaces all raw chunks before it
    // (up to the previous compaction/summary boundary). Stitch them in
    // order, then append any raw chunks after the last boundary.

    const compactions = (summaryData?.compactions || [])
      .sort((a: any, b: any) => a.message_index - b.message_index);

    if (!hasSummary && compactions.length === 0) {
      // No summaries at all — use raw transcript
      const transcript = chunks.map((c: any) => c.content).join('\n\n');
      console.error(`Session ${nickname}: no summaries, sending ${totalChars} chars of raw transcript`);
      process.stdout.write(header + transcript);
      return;
    }

    const parts: string[] = [header];
    let coveredUpTo = 0; // chunk index boundary

    // Each compaction covers from the previous boundary to its message_index
    for (const comp of compactions) {
      parts.push(`## Compaction (up to message ${comp.message_index})\n\n${comp.content}\n\n`);
      coveredUpTo = comp.message_index;
    }

    // AI summary covers everything from the last compaction boundary onward
    if (hasSummary) {
      parts.push('## AI Summary\n\n' + summaryData!.summary!.content + '\n\n');
      coveredUpTo = chunks.length; // summary covers all synced chunks
    }

    // Append raw chunks after the last boundary
    const remaining = chunks.filter((c: any) => c.chunk_index >= coveredUpTo);
    if (remaining.length > 0) {
      parts.push('## Uncovered Activity\n\n');
      parts.push(remaining.map((c: any) => c.content).join('\n\n'));
    }

    console.error(`Session ${nickname}: ${compactions.length} compactions, ${hasSummary ? 'has' : 'no'} AI summary, ${remaining.length} uncovered chunks`);
    process.stdout.write(parts.join(''));
  } catch (err: any) {
    console.error(`Failed to fetch session content: ${err.message}`);
    process.exit(1);
  }
});
