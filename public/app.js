import { STACK, SHEETS_PER_ORDER, orderIndex, newStack, drop, offsetAt, slideOf, verifyScorecard } from './stack.js';

const find = id => document.getElementById(id);
const ui = Object.fromEntries([
  'tower', 'score', 'game-status', 'play', 'drop', 'hint', 'save', 'player', 'error', 'leaders', 'empty-board',
  'challenge-day', 'proof-title', 'proof-copy', 'proof-link', 'share', 'share-status', 'share-url',
  'proof-details', 'proof-seed', 'proof-program', 'proof-account', 'target',
  'scorecard', 'scorecard-result', 'share-score', 'scorecard-status', 'scorecard-url',
  'order-ticket', 'order-list', 'order-progress', 'order-detail', 'order-timer',
  'run-audit', 'audit-name', 'audit-result', 'audit-timings', 'audit-drop-log',
  'draw-jump', 'proof-heading', 'target-row', 'target-audit', 'saved-audit', 'current-challenge',
].map(id => [id, find(id)]));
const offline = typeof localPracticeApi === 'function';
const ctx = ui.tower.getContext('2d');
const params = new URLSearchParams(location.search);
const targetReceipt = params.get('receipt');
const legacyTarget = Number(params.get('beat'));
const base = { x: 0, z: 0, w: STACK.w, d: STACK.d, color: 0 };
const paper = [
  ['#f6e9ce', '#bba782', '#ddc8a2'], ['#e4d3b4', '#ae9875', '#c1a988'],
  ['#e9ae83', '#a75d42', '#c8815e'], ['#f9dfad', '#b68958', '#d7ae73'],
];
let challenge;
let round;
let targetScore = 0;
let savedReceipt;
let clock = 0;
let state = newStack(0);
let layers = [base];
let debris;
let feedback = '';
let movement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

async function api(path, data) {
  if (offline) return localPracticeApi(path, data);
  const res = await fetch(path, data && {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Try again.');
  return result;
}

function message(text = '') {
  ui.error.textContent = text;
  ui.error.hidden = !text;
}

function status(text) {
  if (ui['game-status'].textContent !== text) ui['game-status'].textContent = text;
}

const sheetCount = score => `${score} ${score === 1 ? 'sheet' : 'sheets'}`;

function showOrder() {
  if (!state.orders.length) return;
  const active = orderIndex(state.n) % state.orders.length;
  for (const [index, item] of [...ui['order-list'].children].entries()) {
    if (index === active) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }
  ui['order-progress'].textContent = `${state.n % SHEETS_PER_ORDER} of ${SHEETS_PER_ORDER} sheets`;
  ui['order-detail'].textContent = state.orders[active].rule;
  ui['order-timer'].hidden = true;
}

function setupOrders() {
  ui['order-ticket'].hidden = state.orders.length === 0;
  if (!state.orders.length) return;
  ui['order-list'].replaceChildren(...state.orders.map((order, index) => {
    const item = document.createElement('li');
    const number = document.createElement('span');
    const summary = document.createElement('small');
    number.textContent = index + 1;
    summary.textContent = order.summary;
    item.append(number, order.name, summary);
    return item;
  }));
  showOrder();
}

function showRunAudit(receipt) {
  const audit = ui['run-audit'];
  const hasTimings = Array.isArray(receipt?.drops);
  audit.hidden = !hasTimings;
  audit.open = false;
  ui['audit-timings'].open = false;
  if (!hasTimings) return;
  ui['audit-name'].textContent = `Check ${receipt.name}'s run`;
  ui['audit-result'].textContent = verifyScorecard(challenge.seed, challenge.rules, receipt)
    ? `Replaying the saved timing with this draw reproduces ${sheetCount(receipt.score)}.`
    : 'The saved timing did not reproduce this score.';
  ui['audit-drop-log'].textContent = receipt.drops.map(timing => `${timing} ms`).join(', ');
}

function openRunAudit(event, receipt) {
  event.preventDefault();
  showRunAudit(receipt);
  ui['run-audit'].open = true;
  ui['audit-name'].focus();
}

function showLeaders(rows) {
  const list = rows.map(({ name, score }) => {
    const item = document.createElement('li');
    const text = document.createElement('span');
    const total = document.createElement('b');
    text.textContent = name;
    total.textContent = score;
    item.append(text, total);
    return item;
  });
  ui.leaders.replaceChildren(...list);
  ui['empty-board'].hidden = rows.length > 0;
}

function polygon(points, fill, stroke) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function slab(sheet, level, colors, thickness, project) {
  const { x, z, w, d } = sheet;
  const corners = [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x + w / 2, z + d / 2], [x - w / 2, z + d / 2]];
  const top = corners.map(([x, z]) => project(x, z, level));
  const bottom = corners.map(([x, z]) => project(x, z, level - thickness));
  polygon([top[1], top[2], bottom[2], bottom[1]], colors[1], '#202637');
  polygon([top[2], top[3], bottom[3], bottom[2]], colors[2], '#202637');
  polygon(top, colors[0], '#202637');
}

function dropGuide(level, project) {
  const { x, z, w, d } = state;
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.8;
  polygon([
    project(x - w / 2, z - d / 2, level), project(x + w / 2, z - d / 2, level),
    project(x + w / 2, z + d / 2, level), project(x - w / 2, z + d / 2, level),
  ], 'transparent', '#ead5ac');
  ctx.restore();
}

function render() {
  const width = ui.tower.clientWidth;
  const height = width < 620 ? width * .73 : Math.min(380, width * .54);
  const ratio = Math.min(devicePixelRatio, 2);
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  if (ui.tower.width !== w || ui.tower.height !== h) {
    ui.tower.width = w;
    ui.tower.height = h;
  }
  const scale = w / 760;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const viewHeight = h / scale;
  ctx.fillStyle = '#202735';
  ctx.fillRect(0, 0, 760, viewHeight);
  ctx.fillStyle = '#2b3546';
  ctx.fillRect(0, viewHeight * .72, 760, viewHeight * .28);
  const y = viewHeight * .6 + Math.min(layers.length - 1, 10) * 6;
  const project = (x, z, level) => [380 + (x - z) * 59, y + (x + z) * 22 - level * 79];
  const first = Math.max(0, layers.length - 17);
  if (!first) slab({ ...base, w: 3.4, d: 2.6 }, -.12, ['#758694', '#435263', '#556879'], .48, project);
  layers.slice(first).forEach((sheet, index) => slab(sheet, index * STACK.layer, paper[sheet.color], .13, project));
  if (!round) slab({ ...base, x: .85 }, .72, paper[2], .13, project);

  const time = Date.now() + clock;
  if (debris && !reducedMotion.matches) {
    const age = (time - debris.at) / 1000;
    if (age > .45) debris = null;
    else slab(debris, debris.level - age * age * 12, paper[debris.color], .12, project);
  }
  if (round?.active && time >= round.spawn) {
    const slide = slideOf(state);
    const elapsed = movement ?? time - round.spawn;
    const sheet = { x: state.x, z: state.z, w: state.w, d: state.d };
    sheet[slide.axis] += offsetAt(state, elapsed);
    const color = slide.order?.color ?? (state.n + 1) % paper.length;
    const level = (layers.length - first) * STACK.layer + .08;
    dropGuide(level, project);
    slab(sheet, level, paper[color], .13, project);
    if (slide.maxWait < STACK.maxWait) {
      const countdown = `${Math.max(0, (slide.maxWait - elapsed) / 1000).toFixed(1)}s left`;
      if (ui['order-timer'].textContent !== countdown) ui['order-timer'].textContent = countdown;
      ui['order-timer'].hidden = false;
    }
    if (elapsed > slide.maxWait && !round.pending) finishExpired();
  }
  if (round?.active && !round.pending) {
    const left = round.spawn - time;
    ui.drop.disabled = left > 0;
    status(left > 0 && state.n === 0 ? `Starting in ${Math.ceil(left / 1000)}` : feedback || 'Line up the sheet');
  }
  requestAnimationFrame(render);
}

async function start() {
  ui.play.disabled = true;
  message();
  try {
    const sent = Date.now();
    const active = await api('/api/start', { challenge: challenge.id });
    clock = active.serverAt - (Date.now() + sent) / 2;
    round = { ...active, active: true, pending: false };
    state = newStack(challenge.seed, challenge.rules);
    layers = [base];
    debris = null;
    movement = null;
    feedback = '';
    ui.score.textContent = '0';
    ui.save.hidden = true;
    ui.scorecard.hidden = true;
    ui['scorecard-status'].hidden = true;
    ui['scorecard-url'].hidden = true;
    savedReceipt = null;
    showRunAudit(challenge.target);
    showOrder();
    ui.play.hidden = true;
    ui.drop.hidden = false;
    ui.hint.hidden = false;
  } catch (error) {
    message(error.message);
  } finally {
    ui.play.disabled = false;
  }
}

function end(score, error) {
  round.active = false;
  round.pending = false;
  ui.drop.hidden = true;
  ui.hint.hidden = true;
  ui['order-timer'].hidden = true;
  ui.play.textContent = 'Play again';
  ui.play.hidden = false;
  ui.play.focus({ preventScroll: true });
  if (error) {
    status('Run interrupted');
    message(error.message);
    return;
  }
  ui.save.hidden = score === 0;
  status(score > targetScore && targetScore > 0 ? 'You beat the challenge!' : 'Run complete');
}

async function finishExpired() {
  round.pending = true;
  try {
    const done = await api('/api/finish', { round: round.id });
    end(done.score);
  } catch (error) { end(state.n, error); }
}

async function dropSheet() {
  if (!round?.active || round.pending) return;
  const slide = slideOf(state);
  const ms = Math.round(Date.now() + clock - round.spawn);
  if (ms < 0 || ms > slide.maxWait) return;
  round.pending = true;
  movement = ms;
  try {
    const result = await api('/api/drop', { round: round.id, sheet: state.n, ms });
    drop(state, ms);
    const color = result.cut.perfect ? 3 : slide.order?.color ?? state.n % paper.length;
    if (result.cut.ok) layers.push({ x: state.x, z: state.z, w: state.w, d: state.d, color });
    if (result.cut.lost > 0) {
      const horizontal = slide.axis === 'x';
      debris = { ...state, w: horizontal ? result.cut.lost : state.w, d: horizontal ? state.d : result.cut.lost,
        level: Math.min(layers.length, 17) * STACK.layer, color, at: Date.now() + clock };
      const edge = result.cut.ok ? (slide.size + result.cut.lost) / 2 : Math.abs(result.cut.off);
      debris[slide.axis] += Math.sign(result.cut.off) * edge;
    }
    ui.score.textContent = result.score;
    round.spawn = result.spawn;
    feedback = result.cut.perfect ? 'Perfect drop' : '';
    if (result.cut.ok) showOrder();
    if (result.over) end(result.score);
  } catch (error) {
    end(state.n, error);
  } finally {
    round.pending = false;
    movement = null;
  }
}

ui.play.addEventListener('click', start);
ui.drop.addEventListener('click', dropSheet);
ui.tower.addEventListener('pointerdown', dropSheet);
addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || !round?.active) return;
  if (event.target.closest?.('a, button, input, textarea, select, summary, [contenteditable]')) return;
  event.preventDefault();
  dropSheet();
});
ui.save.addEventListener('submit', async event => {
  event.preventDefault();
  const saveButton = ui.save.querySelector('button');
  const completed = round;
  saveButton.disabled = true;
  try {
    const result = await api('/api/score', { round: completed.id, name: ui.player.value });
    showLeaders(result.leaders);
    if (round !== completed) return;
    ui.save.hidden = true;
    if (result.receipt) {
      savedReceipt = result.receipt;
      const orders = state.orders.length ? orderIndex(savedReceipt.score) : 0;
      ui['scorecard-result'].textContent = orders
        ? `${sheetCount(savedReceipt.score)} · ${orders} ${orders === 1 ? 'order' : 'orders'} filled`
        : sheetCount(savedReceipt.score);
      ui.scorecard.hidden = false;
      ui['saved-audit'].hidden = !Array.isArray(savedReceipt.drops);
      showRunAudit(savedReceipt);
    }
    status('Score saved');
    message();
  } catch (error) { message(error.message); }
  finally { saveButton.disabled = false; }
});

async function copyChallenge(feedback, field, receipt) {
  const link = new URL('/', location.origin);
  link.searchParams.set('challenge', challenge.id);
  if (receipt) link.searchParams.set('receipt', receipt.id);
  feedback.hidden = false;
  try {
    await navigator.clipboard.writeText(link.href);
    feedback.textContent = 'Link copied.';
  } catch {
    feedback.textContent = 'Copy the link below.';
    field.hidden = false;
    field.value = link.href;
    field.select();
  }
}

ui.share.addEventListener('click', () => copyChallenge(ui['share-status'], ui['share-url']));
ui['share-score'].addEventListener('click', () => {
  if (savedReceipt) copyChallenge(ui['scorecard-status'], ui['scorecard-url'], savedReceipt);
});
ui['draw-jump'].addEventListener('click', event => {
  event.preventDefault();
  ui['proof-heading'].focus();
});
ui['target-audit'].addEventListener('click', event => openRunAudit(event, challenge.target));
ui['saved-audit'].addEventListener('click', event => openRunAudit(event, savedReceipt));

async function load() {
  try {
    const requested = params.get('challenge');
    const query = new URLSearchParams();
    if (requested) query.set('id', requested);
    if (targetReceipt) query.set('receipt', targetReceipt);
    challenge = await api(`/api/challenge?${query}`);
    state = newStack(challenge.seed, challenge.rules);
    setupOrders();
    const day = ui['challenge-day'];
    day.dateTime = challenge.day;
    day.textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${challenge.day}T12:00:00Z`));
    const proof = challenge.proof;
    ui['proof-title'].textContent = proof ? 'Verified on Solana devnet' : 'Practice challenge';
    ui['proof-title'].closest('.proof').dataset.state = proof ? 'verified' : 'practice';
    ui['draw-jump'].textContent = proof ? 'Verified draw' : 'Practice draw';
    ui['draw-jump'].hidden = false;
    ui['proof-copy'].textContent = proof ? 'Open the transaction that set this sequence.' : 'This challenge uses a local practice seed.';
    if (proof) {
      ui['proof-link'].href = proof.explorer;
      ui['proof-link'].hidden = false;
      ui['proof-seed'].textContent = challenge.seed;
      ui['proof-program'].textContent = proof.program;
      ui['proof-account'].textContent = proof.account;
      ui['proof-details'].hidden = false;
    }
    if (challenge.target) {
      targetScore = challenge.target.score;
      ui.target.textContent = `Beat ${challenge.target.name}'s ${sheetCount(targetScore)}.`;
      ui['target-audit'].hidden = !Array.isArray(challenge.target.drops);
      showRunAudit(challenge.target);
    } else if (targetReceipt && !offline) {
      ui.target.textContent = 'Scorecard unavailable. You can still play this challenge.';
    } else if (Number.isInteger(legacyTarget) && legacyTarget > 0 && legacyTarget <= STACK.maxSheets) {
      targetScore = legacyTarget;
      ui.target.textContent = `Score to beat: ${sheetCount(targetScore)}.`;
    }
    ui['target-row'].hidden = !ui.target.textContent;
    showLeaders(challenge.leaders);
    ui.play.disabled = false;
    ui.share.disabled = offline;
  } catch (error) {
    status('Challenge unavailable');
    ui['proof-title'].textContent = 'Challenge unavailable';
    ui['proof-copy'].textContent = 'Draw details appear when the challenge loads.';
    ui.play.hidden = true;
    ui.hint.hidden = true;
    ui['current-challenge'].hidden = offline;
    message(error.message);
  }
}

load();
render();
