/**
 * Parameter binding for saved queries.
 *
 * Translates `:name` tokens into positional `$N` placeholders, validates
 * provided values against declared parameters, and coerces values to their
 * declared types. SQL strings, line comments, block comments, and the
 * Postgres `::` cast operator are skipped during tokenisation, so they
 * never produce false-positive matches.
 */

export type ParamType = 'text' | 'number' | 'bool' | 'enum';

export interface ParamDecl {
  name: string;
  value_type: ParamType;
  required: boolean;
  default_value: string | null;
  options: string[] | null;
}

export interface BindResult {
  sql: string;
  values: unknown[];
  usedParams: string[];
}

export class ParamBindError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = 'ParamBindError';
  }
}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Walk the SQL and collect ordered occurrences of `:name` tokens that appear
 * outside of string literals, comments, and the `::` cast sequence.
 */
function findTokens(sql: string): Array<{ start: number; end: number; name: string }> {
  const tokens: Array<{ start: number; end: number; name: string }> = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];

    // Single-quoted string. Postgres escapes a quote by doubling it.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; } // escaped quote
          i++; break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted string ($tag$ ... $tag$). Postgres-only convention.
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        i += tag.length;
        const close = sql.indexOf(tag, i);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }

    // Block comment (Postgres allows nesting).
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }

    // Postgres cast operator `::` — skip both colons.
    if (ch === ':' && sql[i + 1] === ':') {
      i += 2;
      continue;
    }

    // Named parameter `:name`.
    if (ch === ':') {
      NAME_RE.lastIndex = i + 1;
      const m = NAME_RE.exec(sql);
      if (m && m.index === i + 1) {
        tokens.push({ start: i, end: i + 1 + m[0].length, name: m[0] });
        i += 1 + m[0].length;
        continue;
      }
      // Lone colon — leave it; pg will error on it itself.
      i++;
      continue;
    }

    i++;
  }
  return tokens;
}

function coerce(decl: ParamDecl, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') {
    if (decl.required) {
      throw new ParamBindError(`Missing required parameter :${decl.name}`, decl.name);
    }
    if (decl.default_value !== null && decl.default_value !== undefined) {
      return coerce({ ...decl, default_value: null }, decl.default_value);
    }
    return null;
  }

  switch (decl.value_type) {
    case 'text':
      return String(raw);
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        throw new ParamBindError(`Parameter :${decl.name} must be a number`, decl.name);
      }
      return num;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      throw new ParamBindError(`Parameter :${decl.name} must be a boolean`, decl.name);
    }
    case 'enum': {
      const value = String(raw);
      const options = decl.options || [];
      if (!options.includes(value)) {
        throw new ParamBindError(
          `Parameter :${decl.name} must be one of [${options.join(', ')}]`,
          decl.name,
        );
      }
      return value;
    }
    default:
      throw new ParamBindError(`Unknown value_type for :${decl.name}`, decl.name);
  }
}

export function bindNamedParams(
  sql: string,
  declared: ParamDecl[],
  values: Record<string, unknown>,
): BindResult {
  const tokens = findTokens(sql);
  const declaredByName = new Map(declared.map((d) => [d.name, d]));

  // Reject unknown tokens up front so the user gets a useful error.
  for (const t of tokens) {
    if (!declaredByName.has(t.name)) {
      throw new ParamBindError(
        `SQL references undeclared parameter :${t.name}`,
        t.name,
      );
    }
  }

  // Reject value keys that aren't declared.
  for (const key of Object.keys(values)) {
    if (!declaredByName.has(key)) {
      throw new ParamBindError(
        `Unknown parameter "${key}" supplied at run time`,
        key,
      );
    }
  }

  const slot = new Map<string, number>();
  const positional: unknown[] = [];

  // Reserve a positional slot per distinct name in occurrence order.
  for (const t of tokens) {
    if (slot.has(t.name)) continue;
    const decl = declaredByName.get(t.name)!;
    const value = coerce(decl, values[t.name]);
    positional.push(value);
    slot.set(t.name, positional.length); // 1-indexed
  }

  // Make sure required-but-unused params still error.
  for (const decl of declared) {
    if (decl.required && !slot.has(decl.name)) {
      // Required but never referenced in SQL — coerce to surface the missing-value error.
      coerce(decl, values[decl.name]);
    }
  }

  // Rewrite `:name` → `$N`, walking right-to-left so offsets stay valid.
  let out = sql;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const slotNum = slot.get(t.name)!;
    out = out.slice(0, t.start) + `$${slotNum}` + out.slice(t.end);
  }

  return {
    sql: out,
    values: positional,
    usedParams: Array.from(slot.keys()),
  };
}
