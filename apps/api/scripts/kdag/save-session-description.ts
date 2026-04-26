#!/usr/bin/env tsx
/**
 * Kdag code step: Save a session description (summary label).
 *
 * Input (stdin): JSON with session_id and description fields
 * Output (stdout): Confirmation JSON
 *
 * PATCHes the session's summary field with the distilled label.
 */

const API_URL = process.env.KHEF_API_URL || 'http://localhost:3201';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const cleaned = input.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    // Safe parse: template interpolation may produce broken JSON if the label
    // contains quotes or newlines. Try JSON first, fall back to regex extraction.
    let session_id: string | undefined;
    let description: string | undefined;
    try {
      const data = JSON.parse(cleaned);
      session_id = data.session_id;
      description = data.description;
    } catch {
      // Extract fields from malformed JSON via regex
      const sidMatch = cleaned.match(/"session_id"\s*:\s*"([^"]+)"/);
      const descMatch = cleaned.match(/"description"\s*:\s*"([\s\S]*?)"\s*[,}]/);
      session_id = sidMatch?.[1];
      description = descMatch?.[1] || cleaned.replace(/.*"description"\s*:\s*"?/i, '').replace(/"?\s*}?\s*$/, '').trim();
    }

    if (!session_id || !description) {
      console.error(`Missing fields — session_id: ${!!session_id}, description: ${!!description}`);
      process.exit(1);
    }

    // Clean up the description — remove quotes, extra whitespace
    const label = description.replace(/^["']|["']$/g, '').trim();

    const res = await fetch(`${API_URL}/api/sessions/${session_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: label }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`PATCH failed: ${res.status} ${text}`);
      process.exit(1);
    }

    const result = await res.json();
    console.error(`Saved description for session ${session_id}: "${label}"`);
    process.stdout.write(JSON.stringify({ saved: true, session_id, description: label }));
  } catch (err: any) {
    console.error(`Failed to save description: ${err.message}`);
    process.exit(1);
  }
});
