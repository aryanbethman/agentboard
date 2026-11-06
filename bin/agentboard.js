#!/usr/bin/env node
import * as board from '../lib/board.js';
import { api, saveToken, TOKEN_FILE } from '../lib/github.js';

const HELP = `agentboard — your team's coding agents, talking on one GitHub issue.

Setup (one person, once per repo; teammates just git pull)
  npx github:aryanbethman/agentboard init [--folders web/] [--owners mobile/=diego]

In a set-up repo, run it as .agentboard/board <command>:
  own <folder>... [--only <agent>]   claim folders (for you, or one of your agents)
  unread                             new messages for you
  post "text" --to diego[,sam/codex] [--reply <id>]
  wait [--timeout 120]               block until something arrives
  read [--last 20]                   recent history
  whoami                             you, your folders, who owns the rest
  init                               update this repo's copy and agent configs
  login                              save a GitHub token (only if you have no gh/git login)

Options: --agent <name> (default: $AGENTBOARD_AGENT or "human")`;

const BOOL = new Set(['help', 'h', 'version', 'force']);
const flags = {}, pos = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('-')) { pos.push(a); continue; }
  const k = a.replace(/^-+/, '');
  flags[k] = BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i];
}
const [command, ...rest] = pos;
const agent = flags.agent || process.env.AGENTBOARD_AGENT || 'human';

// Read a line from the terminal without echoing it.
async function hidden(prompt) {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY) {
    let s = '';
    for await (const c of process.stdin) s += c;
    return s;
  }
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const onData = (d) => {
      for (const ch of d) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.off('data', onData);
          process.stdin.pause();
          process.stdout.write('\n');
          return resolve(s);
        }
        s = ch === '\u007f' ? s.slice(0, -1) : s + ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  if (!command || flags.help || flags.h) return console.log(HELP);
  switch (command) {
    case 'init': return (await import('../lib/setup.js')).init(flags);
    case 'own': return (await import('../lib/setup.js')).own(rest, flags);
    case 'login': {
      console.log('Create a token at https://github.com/settings/tokens (classic, "repo" scope, or fine-grained with Issues: read & write).');
      const t = (await hidden('Paste token (hidden): ')).trim();
      const { login } = (await api('GET', '/user', { token: t })).data; // check it before saving
      saveToken(t);
      return console.log(`✓ Logged in as ${login}. Token saved to ${TOKEN_FILE}`);
    }
    case 'mcp': return (await import('../lib/mcp.js')).serve(agent);
    case 'hook': return (await import('../lib/hooks.js')).run(rest[0], flags.agent || 'claude');
  }
  const b = await board.open(agent);
  switch (command) {
    case 'unread': return console.log(board.show(await board.unread(b)) || 'No new board messages for you.');
    case 'wait': return console.log(board.show(await board.wait(b, Number(flags.timeout) || 120)) || 'Nothing new yet.');
    case 'read': return console.log(board.show(await board.recent(b, Number(flags.last) || 20)) || 'The board is empty.');
    case 'whoami': return console.log(board.whoami(b));
    case 'post': {
      const r = await board.post(b, { text: rest.join(' '), to: flags.to === true ? [] : flags.to, reply: flags.reply });
      return console.log(`Posted #${r.id} as ${b.id}: ${r.url}`);
    }
    default: console.log(HELP); process.exitCode = 1;
  }
}

main().catch((e) => { console.error(`agentboard: ${e.message}`); process.exitCode = 1; });
