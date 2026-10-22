/**
 * Plain-JS fragment embedded in generated `jevladder-mcp.mjs` (no package imports).
 * Keep in sync with {@link TypeSafeJudge} behaviour.
 */
export function typesafeMcpJudgeSnippet(pluginVersion: string): string {
  const version = JSON.stringify(pluginVersion);
  return `
const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const TYPESAFE_JUDGE_MODEL = 'jev-1.13.0';
const TYPESAFE_JUDGE_TIMEOUT_MS = 8000;
const TYPESAFE_MIN_CONFIDENCE = 0.6;
const PLUGIN_VERSION = ${version};

function resolveJudgeApiKey() {
  const jev = process.env.JEVLADDER_JUDGE_API_KEY;
  if (typeof jev === 'string' && jev.trim()) return jev.trim();
  const ts = process.env.TYPESAFE_API_KEY;
  if (typeof ts === 'string' && ts.trim()) return ts.trim();
  return undefined;
}

function buildCompactDiffState(diff, irreversible) {
  const lines = diff.split(String.fromCharCode(10));
  const files = new Set();
  let linesAdded = 0;
  let linesRemoved = 0;
  const changed = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\\/(\\S+) b\\/(\\S+)$/);
      if (match && match[2]) files.add(match[2]);
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4).split('\\t')[0].replace(/^b\\//, '');
      if (path && path !== '/dev/null') files.add(path);
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1;
      changed.push(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved += 1;
      changed.push(line);
    }
  }
  const fileList = [...files].slice(0, 40);
  const base = { fileCount: files.size, files: fileList, linesAdded, linesRemoved, excerpt: '', irreversible: irreversible === true };
  const metaLen = JSON.stringify({ ...base, excerpt: '' }).length;
  let budget = 2000 - metaLen - 24;
  if (budget < 80) budget = 80;
  let excerpt = '';
  for (const line of changed) {
    const next = excerpt === '' ? line : excerpt + String.fromCharCode(10) + line;
    if (next.length > budget) {
      if (excerpt === '') excerpt = line.slice(0, budget);
      excerpt += String.fromCharCode(10) + '…[excerpt truncated]';
      break;
    }
    excerpt = next;
  }
  return { ...base, excerpt };
}

async function consultTypeSafeJudge(diff, irreversible) {
  const result = (outcome, source, reason) => ({ outcome, source, reason });
  const apiKey = resolveJudgeApiKey();
  if (!apiKey) {
    return result('human', 'judge', 'no judge key configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TYPESAFE_JUDGE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'jevladder/' + PLUGIN_VERSION,
      },
      body: JSON.stringify({
        model: TYPESAFE_JUDGE_MODEL,
        state: buildCompactDiffState(diff, irreversible),
        questions: {
          verdict: {
            type: 'choice',
            instructions: 'Should this proposed merge proceed after deterministic safety rules have already passed?',
            criteria: {
              approve: 'Routine, low-risk code change with no signs of credential exposure, auth bypass, or incomplete work.',
              escalate: 'Any uncertainty, security-sensitive semantics, incomplete change, or need for human review.',
            },
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : 'Error';
    return result('human', 'judge', name === 'AbortError' ? 'timeout' : 'judge request failed: ' + name);
  }
  clearTimeout(timer);
  if (!response.ok) {
    return result('human', 'judge', 'HTTP ' + response.status);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return result('human', 'judge', 'malformed JSON');
  }
  const verdict = data && typeof data === 'object' && data.answers && data.answers.verdict;
  const choice = verdict && verdict.choice;
  const confidence = verdict && verdict.confidence;
  if (choice !== 'approve' && choice !== 'escalate') {
    return result('human', 'judge', 'unknown choice');
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return result('human', 'judge', 'malformed response');
  }
  if (choice === 'escalate' || confidence < TYPESAFE_MIN_CONFIDENCE) {
    return result('human', 'judge', 'typesafe: ' + choice + ' (confidence ' + confidence + ')');
  }
  return result('allow', 'judge', 'typesafe: approve (confidence ' + confidence + ')');
}
`;
}
