import { describe, expect, it } from 'vitest';
import {
  countChangedLines,
  isAddedDiffLine,
  isMinusFileHeader,
  isPlusFileHeader,
  isRemovedDiffLine,
  isStructuredDiff,
  parseDiffFilePaths,
} from '../src/diff-parse.js';

describe('isPlusFileHeader / isMinusFileHeader (B2: strict classification)', () => {
  it('accepts real header forms', () => {
    expect(isPlusFileHeader('+++ b/src/payments/charge.ts')).toBe(true);
    expect(isPlusFileHeader('+++ src/charge.ts')).toBe(true);
    expect(isPlusFileHeader('+++ /dev/null')).toBe(true);
    expect(isPlusFileHeader('+++ b/file.ts\t2026-10-19 10:00:00.000000000 +0200')).toBe(true);
    expect(isMinusFileHeader('--- a/src/payments/charge.ts')).toBe(true);
    expect(isMinusFileHeader('--- /dev/null')).toBe(true);
  });

  it('treats headerless +++ content as content, not headers', () => {
    // No whitespace after +++, or trailing space-separated payload: content.
    expect(isPlusFileHeader('+++password = "FAKE_EXAMPLE_ONLY_1234"')).toBe(false);
    expect(isPlusFileHeader('+++DB_PASSWORD=FAKE_EXAMPLE_ONLY_998273')).toBe(false);
    expect(isPlusFileHeader('+++')).toBe(false);
    expect(isPlusFileHeader('+++ b/file.ts trailing words here')).toBe(false);
    expect(isMinusFileHeader('---password=FAKE_EXAMPLE_ONLY_998273')).toBe(false);
    expect(isMinusFileHeader('---')).toBe(false);
  });
});

describe('isAddedDiffLine / isRemovedDiffLine', () => {
  it('classifies strict headers as headers and everything else as content', () => {
    expect(isAddedDiffLine('+++ b/src/a.ts')).toBe(false);
    expect(isAddedDiffLine('+++ /dev/null')).toBe(false);
    expect(isAddedDiffLine('+export const x = 1;')).toBe(true);
    expect(isAddedDiffLine('++double-plus content')).toBe(true);
    expect(isAddedDiffLine('+++password=hunter212345678')).toBe(true);
    expect(isRemovedDiffLine('--- a/src/a.ts')).toBe(false);
    expect(isRemovedDiffLine('-old line')).toBe(true);
    expect(isRemovedDiffLine('---removed-content')).toBe(true);
  });
});

describe('countChangedLines', () => {
  it('counts added and removed content, excluding strict headers only', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      '+++spoofed-content',
      '---spoofed-content',
    ].join('\n');
    expect(countChangedLines(diff)).toBe(4);
  });
});

describe('isStructuredDiff (B1: never fail open)', () => {
  it('accepts real unified diffs', () => {
    expect(isStructuredDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(true);
    expect(isStructuredDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(true);
    expect(isStructuredDiff('@@ -1,3 +1,4 @@\n context\n+added')).toBe(true);
    expect(isStructuredDiff('+++ b/x\n+content')).toBe(true);
  });

  it('rejects empty and non-diff text', () => {
    expect(isStructuredDiff('')).toBe(false);
    expect(isStructuredDiff('   \n\t\n')).toBe(false);
    expect(isStructuredDiff('this is just prose about a change\nwith no diff markers at all')).toBe(false);
    expect(isStructuredDiff('+++password=hunter212345678\nnothing else')).toBe(false);
    expect(isStructuredDiff('not a diff')).toBe(false);
  });
});

describe('parseDiffFilePaths (B3: binary and headerless diffs)', () => {
  it('extracts paths from +++ headers, skipping /dev/null', () => {
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b', '--- a/deleted.ts', '+++ /dev/null'].join('\n');
    expect(parseDiffFilePaths(diff)).toEqual(['src/a.ts']);
  });

  it('extracts BOTH paths from diff --git headers (covers renames)', () => {
    const rename = [
      'diff --git a/src/payments/charge.ts b/src/billing/charge.ts',
      'similarity index 100%',
      'rename from src/payments/charge.ts',
      'rename to src/billing/charge.ts',
    ].join('\n');
    expect(parseDiffFilePaths(rename)).toEqual(['src/payments/charge.ts', 'src/billing/charge.ts']);
  });

  it('extracts both paths from Binary files notices', () => {
    const binary = [
      'diff --git a/src/assets/logo.png b/src/assets/logo.png',
      'index 1234567..89abcde 100644',
      'Binary files a/src/assets/logo.png and b/src/assets/logo.png differ',
    ].join('\n');
    expect(parseDiffFilePaths(binary)).toEqual(['src/assets/logo.png']);
  });

  it('extracts paths from a pure binary diff touching payments', () => {
    const binary = [
      'diff --git a/src/payments/logo.png b/src/payments/logo.png',
      'Binary files a/src/payments/logo.png and b/src/payments/logo.png differ',
    ].join('\n');
    expect(parseDiffFilePaths(binary)).toContain('src/payments/logo.png');
  });

  it('de-duplicates across header kinds in order', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n');
    expect(parseDiffFilePaths(diff)).toEqual(['src/a.ts']);
  });

  it('does not parse spoofed +++ content lines as paths', () => {
    expect(parseDiffFilePaths('+++password=hunter212345678')).toEqual([]);
    expect(parseDiffFilePaths('+++ b/file.ts smuggled payload words')).toEqual([]);
  });

  it('returns [] for empty or non-diff input', () => {
    expect(parseDiffFilePaths('')).toEqual([]);
    expect(parseDiffFilePaths('no headers here')).toEqual([]);
  });
});
