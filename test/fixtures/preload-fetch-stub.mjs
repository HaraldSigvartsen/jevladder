/**
 * Preload for spawned MCP tests: records fetch calls and returns a minimal
 * TypeSafe System One approve response (no network).
 */
import { appendFileSync } from 'node:fs';

function headerRecord(init) {
  if (!init?.headers || typeof init.headers !== 'object') return {};
  if (init.headers instanceof Headers) {
    return Object.fromEntries([...init.headers.entries()]);
  }
  return { ...init.headers };
}

globalThis.fetch = async (url, init) => {
  const logPath = process.env.JEVLADDER_TEST_FETCH_LOG;
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        url: String(url),
        headers: headerRecord(init),
        body: init?.body ?? '',
      })}\n`,
      'utf8',
    );
  }
  return new Response(
    JSON.stringify({
      answers: { verdict: { choice: 'approve', confidence: 0.92 } },
      model: 'jev-1.13.0',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
