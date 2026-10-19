#!/usr/bin/env node
/**
 * `jev` CLI entry point. Minimal stub for step 1: version and usage only.
 * Real commands (decide, eval, …) arrive in later steps.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version;
    return typeof version === 'string' && version !== '' ? version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

const args = process.argv.slice(2);
const version = readVersion();

if (args[0] === '--version' || args[0] === '-v') {
  console.log(version);
} else {
  console.log(`jev ${version} — clef-gate for AI agents`);
  console.log('Usage:');
  console.log('  jev --version    Print the installed version.');
  console.log('  (decide/eval commands arrive in a later step)');
}
