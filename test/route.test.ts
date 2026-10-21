import { describe, expect, it } from 'vitest';
import { scoreRoute, type RouteResult } from '../src/index.js';

function scored(task: string): RouteResult {
  const result = scoreRoute(task);
  if (result.rejected) throw new Error(`expected a tier, got rejection: ${result.reason}`);
  return result;
}

describe('scoreRoute', () => {
  it('routes typo fixes and docs edits to cheap without abstaining', () => {
    const typo = scored("Fix the typo 'recieve' → 'receive' in README.md.");
    expect(typo.tier).toBe('cheap');
    expect(typo.abstained).toBe(false);

    const docs = scored(
      'Rewrite the getting-started section of docs/getting-started.md for clarity.',
    );
    expect(docs.tier).toBe('cheap');
    expect(docs.abstained).toBe(false);
  });

  it('raises an ambiguous underspecified task one tier and abstains', () => {
    const result = scored('fix login somehow');
    expect(result.abstained).toBe(true);
    expect(result.tier).toBe('mid'); // cheap base, raised for low confidence
    expect(result.explanation).toContain('low-confidence');
    expect(result.signals.some((s) => s.signal === 'ambiguous-without-specifics')).toBe(true);
  });

  it('routes payment migrations to frontier on consequence', () => {
    const result = scored('Migrate payment processing to the new provider');
    expect(result.tier).toBe('frontier');
    expect(result.axes.consequence).toBeGreaterThanOrEqual(0.85);
  });

  it('routes a well-specified tested feature to mid, not frontier', () => {
    const task = [
      'Add cursor pagination to the users API endpoint.',
      'Change src/api/users.ts and src/users/model.ts.',
      "Add tests in test/users.test.ts; the error 'E_TIMEOUT' happens on page 2",
      'repro: GET /api/users?page=2&limit=50.',
    ].join(' ');
    const result = scored(task);
    expect(result.tier).toBe('mid');
    expect(result.abstained).toBe(false);
    expect(result.axes.consequence).toBeLessThan(0.6);
    expect(result.axes.verifiability).toBeGreaterThan(0.5);
    expect(result.explanation).toContain('tier=mid');
  });

  it('never routes deploy/production or delete tasks to cheap', () => {
    expect(scored('Deploy the service to production').tier).not.toBe('cheap');
    expect(scored('Delete the legacy users table').tier).not.toBe('cheap');
  });

  it('keeps axes in [0,1] and returns at most 5 signals sorted by weight', () => {
    const result = scored(
      'Migrate the db schema and the payment API across multiple files, delete old rows, add tests and repro steps',
    );
    for (const value of [result.axes.difficulty, result.axes.consequence, result.axes.verifiability]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect(result.signals.length).toBeLessThanOrEqual(5);
    const weights = result.signals.map((s) => s.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    for (const signal of result.signals) {
      expect(signal.detail).not.toBe('');
    }
  });

  it('is deterministic for identical input', () => {
    const a = scored('improve the thing');
    const b = scored('improve the thing');
    expect(a).toEqual(b);
  });

  it('abstains and raises the tier on very short tasks', () => {
    const short = scored('fix it');
    expect(short.abstained).toBe(true);
    expect(short.tier).toBe('mid');
  });

  it('rejects empty and whitespace-only tasks instead of picking a tier', () => {
    for (const task of ['', '   ', '\n\t']) {
      const rejected = scoreRoute(task);
      expect(rejected.rejected).toBe(true);
      if (!rejected.rejected) continue;
      expect(rejected.reason).toMatch(/empty/i);
    }
  });

  it('throws only on non-string input', () => {
    expect(() => scoreRoute(null as unknown as string)).toThrow(TypeError);
  });
});
