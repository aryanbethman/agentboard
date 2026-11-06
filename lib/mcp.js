// Tiny MCP server over stdio (newline-delimited JSON-RPC). Works with any MCP-capable agent.
import readline from 'node:readline';
import * as board from './board.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  {
    name: 'board_unread',
    description: 'New team-board messages addressed to you or to everyone (marks them read). Call when you start a task and before you finish.',
    inputSchema: obj(),
  },
  {
    name: 'board_post',
    description: 'Post to the team board. Tag owners in `to`: "login" reaches any of their agents, "login/agent" reaches one. Be concrete: file, problem, suggested fix.',
    inputSchema: obj({
      text: { type: 'string' },
      to: { type: 'array', items: { type: 'string' }, description: 'e.g. ["diego"] or ["diego/opencode"]. Omit only for news everyone needs.' },
      reply_to: { type: 'number', description: 'id of the message you are answering' },
    }, ['text']),
  },
  {
    name: 'board_wait',
    description: 'Block until a new message for you arrives, or until the timeout. Use when you are blocked on a teammate.',
    inputSchema: obj({ timeout_seconds: { type: 'number', description: 'default 120, max 600' } }),
  },
  {
    name: 'board_read',
    description: 'The most recent board messages from everyone, read or not.',
    inputSchema: obj({ last: { type: 'number', description: 'default 20' } }),
  },
  {
    name: 'board_whoami',
    description: 'Who you are on the board, your folders, and your teammates with their agents and folders.',
    inputSchema: obj(),
  },
];

async function call(agent, name, a = {}) {
  const b = await board.open(agent);
  switch (name) {
    case 'board_unread': return board.show(await board.unread(b)) || 'No new board messages for you.';
    case 'board_wait': {
      const msgs = await board.wait(b, Math.min(a.timeout_seconds || 120, 600));
      return board.show(msgs) || 'Nothing new yet.';
    }
    case 'board_read': return board.show(await board.recent(b, a.last || 20)) || 'The board is empty.';
    case 'board_whoami': return board.whoami(b);
    case 'board_post': {
      const r = await board.post(b, { text: a.text, to: a.to, reply: a.reply_to });
      return `Posted #${r.id} as ${b.id}: ${r.url}`;
    }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

export function serve(agent) {
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined) return; // notifications
    try {
      if (method === 'initialize') {
        return send({ id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agentboard', version: '0.2.0' },
          instructions: 'Team board for coordinating with teammates\' agents. Check board_unread at the start and end of tasks; tag folder owners with board_post instead of editing their folders.',
        } });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        try {
          const text = await call(agent, params.name, params.arguments);
          return send({ id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
        }
      }
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      send({ id, error: { code: -32603, message: e.message } });
    }
  });
}
