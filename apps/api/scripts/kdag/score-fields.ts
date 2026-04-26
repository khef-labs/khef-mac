#!/usr/bin/env tsx
/**
 * Example kdag "code" step script.
 * Reads JSON from stdin with classified fields, computes deterministic scores.
 *
 * Input (stdin): JSON with an array of fields, each having:
 *   - name: string
 *   - value: string | number
 *   - source_type: "primary" | "secondary" | "derived"
 *   - confidence: "high" | "medium" | "low"
 *
 * Output (stdout): JSON with scored fields and an aggregate score.
 */

const CONFIDENCE_WEIGHTS: Record<string, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.4,
};

const SOURCE_WEIGHTS: Record<string, number> = {
  primary: 1.0,
  secondary: 0.8,
  derived: 0.5,
};

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Strip markdown code fences if present (LLMs sometimes wrap JSON in ```json ... ```)
    const cleaned = input.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const data = JSON.parse(cleaned);
    const fields = data.fields || data;

    if (!Array.isArray(fields)) {
      console.error('Expected "fields" array in input');
      process.exit(1);
    }

    const scored = fields.map((f: any) => {
      const confidenceWeight = CONFIDENCE_WEIGHTS[f.confidence] ?? 0.5;
      const sourceWeight = SOURCE_WEIGHTS[f.source_type] ?? 0.5;
      const score = Math.round((confidenceWeight * sourceWeight) * 100) / 100;
      return { ...f, score };
    });

    const aggregate = scored.length > 0
      ? Math.round((scored.reduce((sum: number, f: any) => sum + f.score, 0) / scored.length) * 100) / 100
      : 0;

    const output = {
      fields: scored,
      aggregate_score: aggregate,
      total_fields: scored.length,
    };

    process.stdout.write(JSON.stringify(output, null, 2));
  } catch (err: any) {
    console.error(`Failed to process input: ${err.message}`);
    process.exit(1);
  }
});
