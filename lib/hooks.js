// Claude Code hooks: deliver board messages automatically and guard other people's folders.
// Hooks never break the agent: any failure exits quietly.
import path from 'node:path';
import * as board from './board.js';

const THROTTLE = Number(process.env.AGENTBOARD_HOOK_THROTTLE ?? 10); // seconds between checks from prompt/stop hooks

const readStdin = async () => {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  try { return JSON.parse(s); } catch { return {}; }
};

export async function run(event, agent = 'claude') {
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  try {
    if (event === 'pre-edit') return preEdit(input, agent, cwd);
    const b = await board.open(agent, cwd);
    if (event === 'session-start') {
      const msgs = await board.unread(b);
      console.log(board.whoami(b));
      console.log(msgs.length ? `\nNew board messages for you:\n\n${board.show(msgs)}` : '\nNo new board messages for you.');
    } else if (event === 'prompt') {
      // Rapid back-and-forth with your agent shouldn't pay a GitHub round trip every time.
      const msgs = await board.unread(b, { throttle: THROTTLE });
      if (msgs.length) console.log(`New board messages for you:\n\n${board.show(msgs)}`);
    } else if (event === 'stop') {
      const msgs = await board.unread(b, { throttle: THROTTLE });
      if (msgs.length) {
        console.log(JSON.stringify({
          decision: 'block',
          reason: `New board messages arrived. Handle the ones in your folders and reply with board_post (reply_to); tell your human about anything else.\n\n${board.show(msgs)}`,
        }));
      }
    }
  } catch (e) {
    if (event === 'session-start') console.log(`Agent board unavailable: ${e.message}`);
  }
}

async function preEdit(input, agent, cwd) {
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  const root = board.findRoot(cwd);
  if (!file || !root) return;
  const rel = path.relative(root, path.resolve(cwd, file));
  if (rel.startsWith('..')) return;
  const cfg = board.loadConfig(root);
  const who = board.owner(cfg, rel);
  const login = board.readJson(path.join(root, board.DIR, 'state', 'me.json'))?.login;
  if (!login || board.mayEdit({ login, id: `${login}/${agent}` }, who)) return;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `${rel} is in ${who}'s folder. Usually you should board_post to "${who}" with the change you need instead of editing it.`,
    },
  }));
}
