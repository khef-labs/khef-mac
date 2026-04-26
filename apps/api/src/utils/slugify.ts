/**
 * Convert a string to a valid kebab-case handle
 *
 * Rules:
 * - Lowercase only
 * - Alphanumeric characters and hyphens
 * - No consecutive hyphens
 * - No leading or trailing hyphens
 * - Matches regex: ^[a-z0-9]+(?:-[a-z0-9]+)*$
 *
 * @param input - String to convert to a handle
 * @returns Kebab-case handle suitable for URLs
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove all non-alphanumeric characters except hyphens
    .replace(/[^a-z0-9-]/g, '')
    // Replace multiple consecutive hyphens with a single hyphen
    .replace(/-+/g, '-')
    // Remove leading and trailing hyphens
    .replace(/^-+|-+$/g, '');
}

/**
 * Validate if a string is a valid handle format
 *
 * @param handle - String to validate
 * @returns True if valid handle format
 */
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle);
}
