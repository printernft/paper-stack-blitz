import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { PRINT_ORDERS } from '../public/stack.js';

const publicFile = name => new URL(`../public/${name}`, import.meta.url);
const read = name => readFileSync(publicFile(name), 'utf8');
const day = new Date().toISOString().slice(0, 10);
const seed = createHash('sha256').update(`paper-stack-preview:${day}`).digest().readUInt32LE();
const challenge = { id: `practice-${day}-${PRINT_ORDERS}`, day, seed, rules: PRINT_ORDERS, proof: null };

const localApi = String.raw`
const localChallenge = ${JSON.stringify(challenge)};
const localScores = new Map();
let localRun;
let runNumber = 0;

function localLeaders() {
  return [...localScores.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

async function localPracticeApi(path, input) {
  if (path.startsWith('/api/challenge')) return { ...localChallenge, leaders: localLeaders() };
  if (path === '/api/start') {
    const id = String(++runNumber);
    const serverAt = Date.now();
    const spawn = serverAt + STACK.countMs;
    localRun = { id, spawn, state: newStack(localChallenge.seed, localChallenge.rules) };
    return { id, serverAt, spawn };
  }
  if (input.round !== localRun?.id) throw new Error('Start a fresh practice run.');
  switch (path) {
    case '/api/drop': {
      const cut = drop(localRun.state, input.ms);
      localRun.spawn += input.ms + STACK.spawnMs;
      return { cut, score: localRun.state.n, over: localRun.state.over, spawn: localRun.spawn };
    }
    case '/api/finish':
      localRun.state.over = true;
      return { score: localRun.state.n };
    case '/api/score': {
      const name = input.name.trim().replace(/\s+/g, ' ');
      const score = localRun.state.n;
      if (!localRun.state.over || score === 0 || !/^[\p{L}\p{N}][\p{L}\p{N} ._]{0,19}$/u.test(name)) {
        throw new Error('Finish a run with at least one sheet and enter a name of 1 to 20 characters.');
      }
      const key = name.toLocaleLowerCase('en-US');
      if (score > (localScores.get(key)?.score ?? 0)) localScores.set(key, { name, score });
      return { leaders: localLeaders() };
    }
    default:
      throw new Error('This action needs the hosted challenge.');
  }
}
`;

const stack = read('stack.js').replace(/^export /gm, '');
const app = read('app.js').replace(/^import [^\n]+\n/, '');
const script = [stack, localApi, app].join('\n');
new Script(script);

const files = { 'stack.jpg': 'image/jpeg', 'magicblock.png': 'image/png' };
const standalone = read('index.html')
  .replace('<link rel="stylesheet" href="/style.css">', () => `<style>${read('style.css')}</style>`)
  .replace('  <script type="module" src="/app.js"></script>', '')
  .replaceAll(/src="\/assets\/([^\"]+)"/g, (_, name) => {
    if (!files[name]) throw new Error(`Add the media type for ${name}.`);
    return `src="data:${files[name]};base64,${readFileSync(publicFile(`assets/${name}`)).toString('base64')}"`;
  })
  .replace('id="leaderboard-heading">Leaderboard', 'id="leaderboard-heading">Local leaderboard')
  .replace('<button id="share"', '<p class="local-note">Scores stay in this tab.</p>\n          <button hidden id="share"')
  .replace('</body>', () => `<script>\n${script}\n</script>\n</body>`);

const output = new URL('../Paper-Stack-MagicBlock-Local.html', import.meta.url);
writeFileSync(output, standalone, 'utf8');
console.log(`Wrote ${Buffer.byteLength(standalone)} bytes to Paper-Stack-MagicBlock-Local.html.`);
