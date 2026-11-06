// Minimal GitHub REST client. Uses whatever GitHub login you already have:
// GH_TOKEN / GITHUB_TOKEN, a saved token, the gh CLI, or the token git uses to push (credential helper).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILE = path.join(os.homedir(), '.config', 'agentboard', 'token');
const base = () => (process.env.AGENTBOARD_API || 'https://api.github.com').replace(/\/$/, '');
const quiet = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 };

function fromGit() {
  const out = execFileSync('git', ['credential', 'fill'], {
    ...quiet, input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
  });
  return /^password=(.+)$/m.exec(out)?.[1];
}

let cached;
export function token() {
  if (cached) return cached;
  const sources = [
    () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    () => execFileSync('gh', ['auth', 'token'], quiet).trim(),
    fromGit,
  ];
  for (const s of sources) {
    try { cached = s(); } catch {}
    if (cached) return cached;
  }
  throw new Error('No GitHub login found. Any one of these works: `gh auth login`, export GH_TOKEN=<token>, or `.agentboard/board login`.');
}

export function saveToken(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t.trim() + '\n', { mode: 0o600 });
  cached = t.trim();
}

export async function api(method, url, { body, etag, timeout = 15000, token: t } = {}) {
  const headers = {
    Authorization: `Bearer ${t || token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentboard',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url.startsWith('http') ? url : base() + url, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 304) return { status: 304 };
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`GitHub ${method} ${url.split('?')[0]} failed (${res.status}): ${data?.message || text}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
  return { status: res.status, data, etag: res.headers.get('etag'), next: next?.[1] };
}

export async function graphql(query, variables) {
  return (await api('POST', base().replace(/\/v3$/, '') + '/graphql', { body: { query, variables } })).data;
}
