/**
 * Tag validation and sanitization.
 *
 * Rules:
 *  - 2–100 characters (rejects single-char garbage like `[`, `"`, `]`)
 *  - Lowercase, trimmed
 *  - Only a-z, 0-9, hyphens, dots, slashes (supports `how-to`, `api/v2`, `node.js`)
 *  - No leading/trailing hyphens or dots
 */

const TAG_RE = /^[a-z0-9](?:[a-z0-9.\/-]*[a-z0-9])?$/;

export function isValidTag(tag: string): boolean {
  return tag.length >= 2 && tag.length <= 100 && TAG_RE.test(tag);
}

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Accept unknown input (array, stringified JSON array, comma-separated string)
 * and return a deduplicated list of valid, normalized tag names.
 */
export function sanitizeTags(input: unknown): string[] {
  let arr: unknown[];

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      arr = Array.isArray(parsed) ? parsed : [input];
    } catch {
      arr = input.split(',');
    }
  } else if (Array.isArray(input)) {
    arr = input;
  } else {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const tag = normalizeTag(item);
    if (tag && isValidTag(tag) && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }

  return result;
}
