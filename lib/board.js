// The board: one GitHub issue. Each comment is a message from `login/agent` to some teammates.
//
//   **[aryan/claude]** → @diego (opencode), @sam
//
//   panel overflows at 390px, fix: repeat(2, minmax(0, 1fr))
//
// `@diego` reaches whichever of Diego's agents checks first (claimed with a 👀 reaction);
// `@diego (opencode)` reaches only that agent. No recipients = everyone.
// Anyone with access to the repo (owner, member, collaborator) is on the team; nobody else is heard.
import fs from 'node:fs';
import path from 'node:path';
import { api } from './github.js';

export const DIR = '.agentboard';
export const CLI = `${DIR}/board`;

export function findRoot(start = process.cwd()) {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, DIR, 'config.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

export const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } };
export const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};

// Config: { repo, issue, folders: { "web/": "aryan", "web/api/": "aryan/codex", "mobile/": "diego" } }
export function loadConfig(root) {
  const cfg = readJson(path.join(root, DIR, 'config.json'));
  if (!cfg?.repo || !cfg?.issue) throw new Error(`${DIR}/config.json is missing "repo" or "issue".`);
  if (cfg.team && !cfg.folders) { // v0.1 format
    cfg.folders = {};
    for (const [login, m] of Object.entries(cfg.team)) {
      for (const f of m.folders || []) cfg.folders[f] = login.toLowerCase();
      for (const [a, fs] of Object.entries(m.agentFolders || {})) for (const f of fs) cfg.folders[f] = `${login.toLowerCase()}/${a}`;
    }
    delete cfg.team;
  }
  cfg.folders = Object.fromEntries(Object.entries(cfg.folders || {}).map(([f, who]) => [f, who.toLowerCase()]));
  return cfg;
}

const statePath = (b, name) => path.join(b.root, DIR, 'state', `${name}.json`);

export async function myLogin(root) {
  const p = path.join(root, DIR, 'state', 'me.json');
  const hit = readJson(p);
  if (hit?.login) return hit.login;
  const login = (await api('GET', '/user')).data.login.toLowerCase();
  writeJson(p, { login });
  return login;
}

// Open the board for one agent. Throws a friendly error if this repo isn't set up.
export async function open(agent, cwd) {
  const root = findRoot(cwd);
  if (!root) throw new Error('No agent board in this repo. Set one up with: npx github:aryanbethman/agentboard init');
  const cfg = loadConfig(root);
  const login = await myLogin(root);
  agent = (agent || 'human').toLowerCase();
  return { root, cfg, login, agent, id: `${login}/${agent}` };
}

export const boardUrl = (cfg) => `https://github.com/${cfg.repo}/issues/${cfg.issue}`;

// ---------- parsing ----------

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const HEAD = /^\*\*\[([\w.-]+)\/([\w.-]+)\]\*\*(?:\s*→\s*(.*?))?\s*$/;
const MENTION = /(?<![\w.])@([A-Za-z0-9-]+)(?:\s*\(([\w.-]+)\))?/g;

const mentions = (s) => [...s.matchAll(MENTION)].map((m) => ({ login: m[1].toLowerCase(), agent: m[2]?.toLowerCase() || null }));

export function parse(c) {
  if (!TRUSTED.has(c.author_association)) return null; // only people with repo access can talk to your agents
  const login = c.user.login.toLowerCase();
  const [first, ...rest] = (c.body || '').split('\n');
  const h = HEAD.exec(first);
  const m = { id: c.id, login, agent: 'human', to: [], text: c.body || '', at: c.created_at, eyes: c.reactions?.eyes || 0 };
  // A header only counts if it matches the real comment author (no spoofing someone else's agent).
  if (h && h[1].toLowerCase() === login) {
    m.agent = h[2].toLowerCase();
    m.to = mentions(h[3] || '');
    m.text = rest.join('\n').trim();
  } else {
    m.to = mentions(m.text);
  }
  m.from = `${login}/${m.agent}`;
  return m;
}

function addressed(m, b) {
  if (m.from === b.id) return null;
  if (!m.to.length) return 'all';
  if (m.to.some((r) => r.login === b.login && r.agent === b.agent)) return 'you';
  if (m.to.some((r) => r.login === b.login && !r.agent)) return 'shared';
  return null;
}

// ---------- reading ----------

async function fetchNew(b, st) {
  const { repo, issue } = b.cfg;
  const since = st.at || new Date(Date.now() - 864e5).toISOString(); // first run: last 24h
  let url = `/repos/${repo}/issues/${issue}/comments?per_page=100&since=${encodeURIComponent(since)}`;
  const out = [];
  for (let first = true; url; first = false) {
    const r = await api('GET', url, { etag: first && st.etagUrl === url ? st.etag : undefined });
    if (r.status === 304) return [];
    if (first) Object.assign(st, r.next ? { etagUrl: null, etag: null } : { etagUrl: url, etag: r.etag });
    out.push(...r.data);
    url = r.next;
  }
  return out.filter((c) => c.id > (st.id || 0)).sort((a, z) => a.id - z.id);
}

// Atomic claim for messages sent to a person: adding 👀 returns 201 the first time, 200 if already there.
async function claim(b, id) {
  const r = await api('POST', `/repos/${b.cfg.repo}/issues/comments/${id}/reactions`, { body: { content: 'eyes' } });
  return r.status === 201;
}

// New messages for this agent. Marks them read. `throttle`: skip the network if we checked that recently (seconds).
export async function unread(b, { throttle = 0 } = {}) {
  const p = statePath(b, b.agent);
  const st = readJson(p, {});
  if (throttle && Date.now() - (st.checkedAt || 0) < throttle * 1000) return [];
  st.checkedAt = Date.now();
  const comments = await fetchNew(b, st);
  const msgs = [];
  for (const c of comments) {
    const m = parse(c);
    const why = m && addressed(m, b);
    if (!why) continue;
    if (why === 'shared' && (m.eyes || !(await claim(b, m.id)))) continue; // a sibling agent has it
    msgs.push({ ...m, why });
  }
  if (comments.length) Object.assign(st, { id: comments.at(-1).id, at: comments.at(-1).created_at });
  writeJson(p, st);
  return msgs;
}

export async function wait(b, seconds = 120, every = 5) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const msgs = await unread(b);
    if (msgs.length || Date.now() >= end) return msgs;
    await new Promise((r) => setTimeout(r, Math.min(every * 1000, end - Date.now())));
  }
}

// The last `n` messages on the board, for everyone.
export async function recent(b, n = 20) {
  const { repo, issue } = b.cfg;
  const total = (await api('GET', `/repos/${repo}/issues/${issue}`)).data.comments;
  const pages = Math.max(1, Math.ceil(total / 100));
  let comments = [];
  for (let page = pages; page >= 1 && comments.length < n; page--) {
    comments = (await api('GET', `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`)).data.concat(comments);
  }
  return comments.map(parse).filter(Boolean).slice(-n);
}

// ---------- writing ----------

// Catch typos in `to` before they silently go nowhere. Known = folder owners, you, or a checked collaborator.
async function checkLogin(b, login) {
  const owners = Object.values(b.cfg.folders).map((w) => w.split('/')[0]);
  if (login === b.login || owners.includes(login)) return;
  const p = statePath(b, 'known');
  const known = readJson(p, []);
  if (known.includes(login)) return;
  try {
    await api('GET', `/repos/${b.cfg.repo}/collaborators/${login}`);
  } catch (e) {
    if (/\(404\)/.test(e.message)) throw new Error(`"${login}" doesn't have access to ${b.cfg.repo}, so their agents can't see the board.`);
    return; // can't check (no permission); let it through
  }
  writeJson(p, [...known, login]);
}

export async function post(b, { text, to = [], reply }) {
  if (!text?.trim()) throw new Error('Nothing to post.');
  to = [].concat(to ?? []);
  if (reply && !to.length) { // reply goes back to whoever sent the original
    const orig = parse((await api('GET', `/repos/${b.cfg.repo}/issues/comments/${reply}`)).data);
    if (orig) to = [orig.from];
  }
  const tags = [];
  for (const t of to.flatMap((t) => String(t).split(',')).map((t) => t.trim().replace(/^@/, '')).filter(Boolean)) {
    const [login, agent] = t.toLowerCase().split('/');
    await checkLogin(b, login);
    tags.push(agent ? `@${login} (${agent})` : `@${login}`);
  }
  const lines = [`**[${b.id}]**${tags.length ? ' → ' + tags.join(', ') : ''}`, ''];
  if (reply) lines.push(`↩ re: ${boardUrl(b.cfg)}#issuecomment-${reply}`, '');
  lines.push(text.trim());
  const r = await api('POST', `/repos/${b.cfg.repo}/issues/${b.cfg.issue}/comments`, { body: { body: lines.join('\n') } });
  return { id: r.data.id, url: r.data.html_url };
}

// ---------- folders (who owns what) ----------

export const clean = (f) => f.replace(/^\.\//, '').replace(/\/+$/, '');

// Owner of a repo-relative path: "login", "login/agent", or null. Most specific folder wins.
export function owner(cfg, rel) {
  rel = clean(rel);
  let best = null, len = -1;
  for (const [f0, who] of Object.entries(cfg.folders)) {
    const f = clean(f0);
    if (f && (rel === f || rel.startsWith(f + '/')) && f.length > len) { best = who; len = f.length; }
  }
  return best;
}

export const mayEdit = (b, who) => !who || who === b.login || who === b.id;

// ---------- display ----------

const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`;
};

const label = (m) =>
  m.why === 'you' ? 'you'
  : m.why === 'shared' ? `${m.to.find((r) => !r.agent)?.login} (any of their agents; you picked it up)`
  : m.why === 'all' || !m.to.length ? 'everyone'
  : m.to.map((r) => (r.agent ? `${r.login}/${r.agent}` : r.login)).join(', ');

export const show = (msgs) => msgs.map((m) => `#${m.id} · ${ago(m.at)} · ${m.from} → ${label(m)}\n${m.text}`).join('\n\n');

// Spelled out from this agent's point of view, so there's no room to misread who owns what.
export function whoami(b) {
  const mine = [], theirs = new Map();
  for (const [f, who] of Object.entries(b.cfg.folders)) {
    if (mayEdit(b, who)) mine.push(f);
    else theirs.set(who, [...(theirs.get(who) || []), f]);
  }
  return [
    `You are ${b.id} on the agent board ${boardUrl(b.cfg)}`,
    mine.length ? `You may edit: ${mine.join(', ')} (plus files nobody owns).`
      : `No folders are assigned to you yet; you may edit files nobody owns. If your human says which folders are theirs, run: ${CLI} own <folder>`,
    ...(theirs.size ? ['NOT yours. Don\'t edit these; board_post the owner what you need instead:',
      ...[...theirs].map(([who, fs]) => `- ${fs.join(', ')} → ${who}`)] : []),
    `Tag "login" to reach any of someone's agents, or "login/agent" for one. A reply with no "to" goes back to the sender.`,
  ].join('\n');
}
