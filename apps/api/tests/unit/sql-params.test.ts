import { describe, it, expect } from 'vitest';
import { bindNamedParams, ParamBindError, type ParamDecl } from '../../src/services/dbx/sql-params';

const decl = (over: Partial<ParamDecl> & { name: string }): ParamDecl => ({
  value_type: 'text',
  required: false,
  default_value: null,
  options: null,
  ...over,
});

describe('bindNamedParams', () => {
  it('rewrites a single :name to $1', () => {
    const r = bindNamedParams(
      'SELECT * FROM t WHERE id = :id',
      [decl({ name: 'id', value_type: 'number', required: true })],
      { id: 42 },
    );
    expect(r.sql).toBe('SELECT * FROM t WHERE id = $1');
    expect(r.values).toEqual([42]);
    expect(r.usedParams).toEqual(['id']);
  });

  it('reuses the same $N for repeated tokens', () => {
    const r = bindNamedParams(
      'SELECT * FROM t WHERE a = :x OR b = :x',
      [decl({ name: 'x' })],
      { x: 'q' },
    );
    expect(r.sql).toBe('SELECT * FROM t WHERE a = $1 OR b = $1');
    expect(r.values).toEqual(['q']);
  });

  it('preserves the order of distinct tokens', () => {
    const r = bindNamedParams(
      'SELECT * WHERE a=:b AND c=:a AND d=:b',
      [decl({ name: 'a' }), decl({ name: 'b' })],
      { a: 'A', b: 'B' },
    );
    expect(r.sql).toBe('SELECT * WHERE a=$1 AND c=$2 AND d=$1');
    expect(r.values).toEqual(['B', 'A']);
  });

  it('skips :name inside single-quoted strings', () => {
    const r = bindNamedParams(
      "SELECT 'hello :name' AS greet, :name AS who",
      [decl({ name: 'name' })],
      { name: 'roger' },
    );
    expect(r.sql).toBe("SELECT 'hello :name' AS greet, $1 AS who");
    expect(r.values).toEqual(['roger']);
  });

  it('skips :name inside double-quoted identifiers', () => {
    const r = bindNamedParams(
      'SELECT "col:name", :real FROM t',
      [decl({ name: 'real' })],
      { real: 'ok' },
    );
    expect(r.sql).toBe('SELECT "col:name", $1 FROM t');
    expect(r.values).toEqual(['ok']);
  });

  it('skips :name inside line comments', () => {
    const r = bindNamedParams(
      '-- comment :ignored\nSELECT :x',
      [decl({ name: 'x', value_type: 'number' })],
      { x: 1 },
    );
    expect(r.sql).toBe('-- comment :ignored\nSELECT $1');
    expect(r.values).toEqual([1]);
  });

  it('skips :name inside block comments (with nesting)', () => {
    const r = bindNamedParams(
      '/* outer /* :ignored */ */ SELECT :x',
      [decl({ name: 'x', value_type: 'number' })],
      { x: 2 },
    );
    expect(r.sql).toBe('/* outer /* :ignored */ */ SELECT $1');
    expect(r.values).toEqual([2]);
  });

  it('does not treat :: cast as two parameters', () => {
    const r = bindNamedParams(
      "SELECT '5'::int + :n",
      [decl({ name: 'n', value_type: 'number' })],
      { n: 1 },
    );
    expect(r.sql).toBe("SELECT '5'::int + $1");
    expect(r.values).toEqual([1]);
  });

  it('skips :name inside dollar-quoted strings', () => {
    const r = bindNamedParams(
      "SELECT $tag$ has :inside $tag$, :outside",
      [decl({ name: 'outside' })],
      { outside: 'x' },
    );
    expect(r.sql).toBe('SELECT $tag$ has :inside $tag$, $1');
    expect(r.values).toEqual(['x']);
  });

  it('rejects undeclared tokens in SQL', () => {
    expect(() =>
      bindNamedParams('SELECT :x', [], {}),
    ).toThrow(/undeclared parameter :x/);
  });

  it('rejects unknown values supplied at run time', () => {
    expect(() =>
      bindNamedParams('SELECT 1', [decl({ name: 'a' })], { a: 1, bogus: 2 }),
    ).toThrow(/Unknown parameter "bogus"/);
  });

  it('errors when a required param is missing', () => {
    expect(() =>
      bindNamedParams(
        'SELECT :x',
        [decl({ name: 'x', required: true })],
        {},
      ),
    ).toThrow(/Missing required parameter :x/);
  });

  it('uses default_value when the param is not supplied', () => {
    const r = bindNamedParams(
      'SELECT :x',
      [decl({ name: 'x', default_value: 'fallback' })],
      {},
    );
    expect(r.values).toEqual(['fallback']);
  });

  it('coerces number values', () => {
    const r = bindNamedParams(
      'SELECT :n',
      [decl({ name: 'n', value_type: 'number' })],
      { n: '42' },
    );
    expect(r.values).toEqual([42]);
  });

  it('rejects non-numeric values for number params', () => {
    expect(() =>
      bindNamedParams(
        'SELECT :n',
        [decl({ name: 'n', value_type: 'number' })],
        { n: 'abc' },
      ),
    ).toThrow(/must be a number/);
  });

  it('coerces bool values from common encodings', () => {
    const cases: Array<[unknown, boolean]> = [
      [true, true], [false, false],
      ['true', true], ['false', false],
      [1, true], [0, false],
      ['1', true], ['0', false],
    ];
    for (const [raw, expected] of cases) {
      const r = bindNamedParams(
        'SELECT :b',
        [decl({ name: 'b', value_type: 'bool' })],
        { b: raw },
      );
      expect(r.values).toEqual([expected]);
    }
  });

  it('rejects enum values not in options', () => {
    expect(() =>
      bindNamedParams(
        'SELECT :m',
        [decl({ name: 'm', value_type: 'enum', options: ['a', 'b'] })],
        { m: 'c' },
      ),
    ).toThrow(/must be one of \[a, b\]/);
  });

  it('passes through enum values that are in options', () => {
    const r = bindNamedParams(
      'SELECT :m',
      [decl({ name: 'm', value_type: 'enum', options: ['exact', 'contains'] })],
      { m: 'contains' },
    );
    expect(r.values).toEqual(['contains']);
  });

  it('still validates required-but-never-referenced params', () => {
    expect(() =>
      bindNamedParams(
        'SELECT 1',
        [decl({ name: 'x', required: true })],
        {},
      ),
    ).toThrow(/Missing required parameter :x/);
  });

  it('attaches the field name to ParamBindError', () => {
    try {
      bindNamedParams(
        'SELECT :n',
        [decl({ name: 'n', value_type: 'number' })],
        { n: 'abc' },
      );
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ParamBindError);
      expect((err as ParamBindError).field).toBe('n');
    }
  });
});
