/**
 * Random nickname generator with cascading dictionary pools.
 *
 * Tries pools in order: names (4,940) → colors (52) → animals (355) → color-animal (~18k).
 * Each pool is exhausted before moving to the next.
 */

import { uniqueNamesGenerator, animals, colors, names } from 'unique-names-generator';

interface Pool {
  generate: () => string;
  size: number;
}

const POOLS: Pool[] = [
  {
    generate: () => uniqueNamesGenerator({ dictionaries: [names], style: 'lowerCase' }),
    size: names.length,
  },
  {
    generate: () => uniqueNamesGenerator({ dictionaries: [colors], style: 'lowerCase' }),
    size: colors.length,
  },
  {
    generate: () => uniqueNamesGenerator({ dictionaries: [animals], style: 'lowerCase' }),
    size: animals.length,
  },
  {
    generate: () => uniqueNamesGenerator({ dictionaries: [colors, animals], separator: '-', style: 'lowerCase' }),
    size: colors.length * animals.length,
  },
];

/**
 * Generate a random nickname from the first pool.
 */
export function randomNickname(): string {
  return POOLS[0].generate();
}

/**
 * Generate a unique nickname not present in the given set.
 * If preferredNames is provided, those are tried first (random order).
 * Otherwise cascades through pools: names → colors → animals → color-animal.
 * Appends random digits as a last resort.
 */
export interface LengthConstraints {
  minLength?: number;
  maxLength?: number;
}

/**
 * Check if a candidate meets length constraints.
 * A value of 0 or undefined means no constraint.
 */
function meetsLengthConstraints(candidate: string, constraints?: LengthConstraints): boolean {
  if (!constraints) return true;
  if (constraints.minLength && candidate.length < constraints.minLength) return false;
  if (constraints.maxLength && candidate.length > constraints.maxLength) return false;
  return true;
}

export function uniqueNickname(
  usedNames: Set<string>,
  preferredNames?: string[],
  lengthConstraints?: LengthConstraints,
  attemptsPerPool = 20,
): string {
  // Try preferred names first (shuffled for variety) — no length filter on custom names
  if (preferredNames && preferredNames.length > 0) {
    const shuffled = [...preferredNames].sort(() => Math.random() - 0.5);
    for (const name of shuffled) {
      const normalized = name.toLowerCase().trim();
      if (normalized && !usedNames.has(normalized)) return normalized;
    }
    // All preferred names taken — fall through to auto-gen pools
  }

  // Increase attempts when length constraints narrow the pool
  const attempts = lengthConstraints?.minLength || lengthConstraints?.maxLength
    ? attemptsPerPool * 5
    : attemptsPerPool;

  for (const pool of POOLS) {
    for (let i = 0; i < attempts; i++) {
      const candidate = pool.generate();
      if (!usedNames.has(candidate) && meetsLengthConstraints(candidate, lengthConstraints)) {
        return candidate;
      }
    }
  }
  // Fallback: color-animal with digits (should never happen with ~23k namespace)
  return POOLS[3].generate() + Math.floor(Math.random() * 100);
}

/**
 * Total namespace size across all pools.
 */
export function namespaceSize(): number {
  return POOLS.reduce((sum, p) => sum + p.size, 0);
}
