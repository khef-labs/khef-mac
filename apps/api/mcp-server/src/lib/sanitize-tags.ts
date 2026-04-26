/**
 * Tag sanitization for MCP layer — catches string-vs-array issues
 * before they reach the API.
 *
 * Mirrors the validation in apps/api/src/utils/tags.ts.
 */

const TAG_RE = /^[a-z0-9](?:[a-z0-9.\/-]*[a-z0-9])?$/;

function isValidTag(tag: string): boolean {
  return tag.length >= 2 && tag.length <= 100 && TAG_RE.test(tag);
}

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
    const tag = item.trim().toLowerCase();
    if (tag && isValidTag(tag) && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }

  return result;
}
