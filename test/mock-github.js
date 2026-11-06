// In-memory stand-in for the few GitHub endpoints agentboard uses.
import http from 'node:http';
import crypto from 'node:crypto';

export function start(users, roles = {}) {
  const role = (login) => roles[login] || 'NONE';
  const issues = new Map(); // number -> { comments: [] }
  const stats = { notModified: 0, requests: 0 };
  let nextId = 1000, nextIssue = 1;

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    let body = '';
    for await (const c of req) body += c;
    body = body ? JSON.parse(body) : {};
    const login = users[(req.headers.authorization || '').replace('Bearer ', '')];
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (!login) return send(401, { message: 'Bad credentials' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    let m;

    if (p === '/user') return send(200, { login });
    if (p === '/graphql') return send(200, { data: { pinIssue: { issue: { number: 1 } } } });
    if (req.method === 'POST' && (m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) {
      const number = nextIssue++;
      issues.set(number, { comments: [] });
      return send(201, { number, node_id: `I_${number}`, html_url: `https://github.com/${m[1]}/issues/${number}` });
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/))) {
      return send(200, { number: +m[2], comments: issues.get(+m[2]).comments.length });
    }
    if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/))) {
      const issue = issues.get(+m[2]);
      if (req.method === 'POST') {
        const now = new Date().toISOString();
        const c = { id: nextId++, user: { login }, author_association: role(login), body: body.body, created_at: now, updated_at: now,
          html_url: `https://github.com/${m[1]}/issues/${m[2]}#issuecomment-${nextId - 1}`, eyesBy: new Set() };
        issue.comments.push(c);
        return send(201, view(c));
      }
      const since = url.searchParams.get('since');
      const per = +url.searchParams.get('per_page') || 30, page = +url.searchParams.get('page') || 1;
      const all = issue.comments.filter((c) => !since || c.updated_at >= since);
      const items = all.slice((page - 1) * per, page * per).map(view);
      const etag = '"' + crypto.createHash('sha1').update(JSON.stringify(items)).digest('hex') + '"';
      if (req.headers['if-none-match'] === etag) { stats.notModified++; return send(304); }
      const headers = { etag };
      if (page * per < all.length) {
        url.searchParams.set('page', page + 1);
        headers.link = `<http://${req.headers.host}${url.pathname}${url.search}>; rel="next"`;
      }
      return send(200, items, headers);
    }
    if ((m = p.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)$/))) {
      return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(role(m[1])) ? send(204) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && (m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/))) {
      return send(200, view([...issues.values()].flatMap((i) => i.comments).find((c) => c.id === +m[1])));
    }
    if (req.method === 'POST' && (m = p.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)\/reactions$/))) {
      const c = [...issues.values()].flatMap((i) => i.comments).find((c) => c.id === +m[1]);
      if (c.eyesBy.has(login)) return send(200, { content: 'eyes' });
      c.eyesBy.add(login);
      return send(201, { content: 'eyes' });
    }
    send(404, { message: `Not Found: ${req.method} ${p}` });
  });

  const view = ({ eyesBy, ...c }) => ({ ...c, reactions: { eyes: eyesBy.size } });
  // Post a raw comment as someone (for spoofing / human tests).
  const raw = (number, login, text) => {
    const now = new Date().toISOString();
    issues.get(number).comments.push({ id: nextId++, user: { login }, author_association: role(login), body: text, created_at: now, updated_at: now, html_url: '', eyesBy: new Set() });
  };

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${server.address().port}`, stats, raw, close: () => server.close() })));
}
