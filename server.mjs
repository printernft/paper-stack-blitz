import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { STACK, PRINT_ORDERS, newStack, drop, slideOf } from './public/stack.js';
import { loadConfiguredChallenge } from './scripts/proof.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stack.js', ['stack.js', 'text/javascript; charset=utf-8']],
  ['/assets/stack.jpg', ['assets/stack.jpg', 'image/jpeg']],
  ['/assets/magicblock.png', ['assets/magicblock.png', 'image/png']],
]);
const roundTtl = 30 * 60 * 1000;
const publicScore = ({ id, name, score, drops, ending }) => ({ id, name, score, drops, ending });

function previewChallenge(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const seed = createHash('sha256').update(`paper-stack-preview:${day}`).digest().readUInt32LE();
  return { id: `practice-${day}`, day, seed, proof: null };
}

function selectChallenge(base, id) {
  if (id === base.id) return base;
  const active = { ...base, id: `${base.id}-${PRINT_ORDERS}`, rules: PRINT_ORDERS };
  return !id || id === active.id ? active : null;
}

function reply(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Send JSON.');
  let buffer = '';
  for await (const chunk of req) {
    buffer += chunk;
    if (buffer.length > 4096) throw new Error('Request too large.');
  }
  const input = JSON.parse(buffer);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send a JSON object.');
  return input;
}

export function createStackServer({ now = Date.now, dataDir = join(root, '.runtime'), verified = null } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const records = join(dataDir, 'scores.ndjson');
  const rows = new Map();
  const receipts = new Map();
  const rounds = new Map();
  const remember = row => {
    if (row.id) receipts.set(row.id, row);
    const key = `${row.challenge}:${row.name.toLocaleLowerCase('en-US')}`;
    const earlier = rows.get(key);
    if (!earlier || row.score > earlier.score) rows.set(key, row);
  };
  try {
    for (const line of readFileSync(records, 'utf8').split('\n').filter(Boolean)) remember(JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const board = id => [...rows.values()].filter(row => row.challenge === id)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, 10).map(({ name, score }) => ({ name, score }));

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const time = now();
    const base = verified ?? previewChallenge(time);
    const path = url.pathname;
    if (req.method === 'GET' && routes.has(path)) {
      const [file, type] = routes.get(path);
      return reply(res, 200, readFileSync(join(root, 'public', file)), type);
    }
    if (req.method === 'GET' && path === '/health') {
      return reply(res, 200, { ready: true, mode: verified ? 'devnet-verified' : 'practice', rules: PRINT_ORDERS });
    }
    if (req.method === 'GET' && path === '/api/challenge') {
      const challenge = selectChallenge(base, url.searchParams.get('id'));
      if (!challenge) return reply(res, 404, { error: 'That challenge has ended.' });
      const receipt = receipts.get(url.searchParams.get('receipt'));
      return reply(res, 200, {
        ...challenge,
        target: receipt?.challenge === challenge.id ? publicScore(receipt) : null,
        leaders: board(challenge.id),
      });
    }
    if (req.method !== 'POST' || !['/api/start', '/api/drop', '/api/finish', '/api/score'].includes(path)) {
      return reply(res, 404, { error: 'Page unavailable.' });
    }
    let input;
    try { input = await body(req); }
    catch { return reply(res, 400, { error: 'Invalid request.' }); }
    if (path === '/api/start') {
      const challenge = typeof input.challenge === 'string' && input.challenge && selectChallenge(base, input.challenge);
      if (!challenge) return reply(res, 409, { error: 'Refresh to load the current challenge.' });
      for (const [id, round] of rounds) if (time - round.created > roundTtl) rounds.delete(id);
      if (rounds.size >= 5000) return reply(res, 503, { error: 'Too many active runs. Try again soon.' });
      const id = randomUUID();
      const serverAt = now();
      const spawn = serverAt + STACK.countMs;
      rounds.set(id, { state: newStack(challenge.seed, challenge.rules), spawn, created: serverAt, challenge: challenge.id, drops: [] });
      return reply(res, 201, { id, serverAt, spawn });
    }
    const round = rounds.get(input.round);
    if (!round || time - round.created > roundTtl) return reply(res, 404, { error: 'Run expired. Play again.' });
    if (path === '/api/drop') {
      const { ms, sheet } = input;
      if (sheet === round.lastDrop?.sheet && ms === round.lastDrop?.ms) return reply(res, 200, round.lastDrop.result);
      if (round.state.over || sheet !== round.state.n || !Number.isInteger(ms) || ms < 0 || ms > slideOf(round.state).maxWait) {
        return reply(res, 409, { error: 'That drop is outside the active round.' });
      }
      const scheduled = round.spawn + ms;
      if (time < scheduled - STACK.aheadMs || time > scheduled + STACK.lagMs) {
        return reply(res, 409, { error: 'The round lost sync. Start another run.' });
      }
      const cut = drop(round.state, ms);
      round.drops.push(ms);
      if (round.state.over) round.ending = 'closed';
      round.spawn = scheduled + STACK.spawnMs;
      const result = { score: round.state.n, over: round.state.over, cut, spawn: round.spawn };
      round.lastDrop = { sheet, ms, result };
      return reply(res, 200, result);
    }
    if (path === '/api/finish') {
      if (!round.state.over && time < round.spawn + slideOf(round.state).maxWait - 100) {
        return reply(res, 409, { error: 'This round is still active.' });
      }
      if (!round.state.over) {
        round.state.over = true;
        round.ending = 'timeout';
      }
      return reply(res, 200, { score: round.state.n });
    }
    if (round.receipt) {
      return reply(res, 200, { leaders: board(round.challenge), receipt: round.receipt });
    }
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!round.state.over || round.state.n === 0 || !/^[\p{L}\p{N}][\p{L}\p{N} ._]{0,19}$/u.test(name)) {
      return reply(res, 400, { error: 'Finish a run with at least one sheet and enter a name of 1 to 20 characters.' });
    }
    const row = {
      id: randomUUID(), name, challenge: round.challenge, score: round.state.n, at: time,
      drops: round.drops, ending: round.ending,
    };
    try { appendFileSync(records, `${JSON.stringify(row)}\n`); }
    catch { return reply(res, 503, { error: 'The leaderboard could not save this run. Try again.' }); }
    remember(row);
    round.receipt = publicScore(row);
    return reply(res, 200, { leaders: board(round.challenge), receipt: round.receipt });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verified = await loadConfiguredChallenge();
  const port = Number(process.env.PORT ?? 19918);
  const host = process.env.HOST ?? '127.0.0.1';
  const dataDir = process.env.STACK_DATA_DIR;
  createStackServer({ verified, dataDir }).listen(port, host, () => console.log(`Paper Stack listening at http://${host}:${port}`));
}
