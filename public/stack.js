// SKILL: Paper Stack, the timing game on its pedestals (shared/skill.js KIOSK; PARKSPACE: no longer on Paper Park). A sheet slides back and forth over
// the tower, across it one way, then the other; drop it: the part that overlaps the sheet below stays, the rest falls
// off. Drop it right on (within STACK.perfect) and nothing is lost; three of those in a row grow the sheet back a
// little. Miss the tower and the round is over: your score is the sheets stacked. Shared by the room (server/skill.mjs
// replays every drop from its own seed) and the browser (games/stack.js shows the same slide and cut).
// Deterministic: the slide is a function of the sheet number, the seed and the drop time in whole milliseconds.
export const STACK = {
  w: 2.8, d: 2.0, layer: 0.16,                              // the first sheet (x by z) and one sheet's thickness
  perfect: 0.06, grow: 0.12, growAfter: 3,                  // a drop this close keeps the whole sheet; three in a row grow it
  speed0: 1.5, speedUp: 0.06, speedMax: 3.2,                // the slide's speed (m/s): it rises a little with every sheet
  spawnMs: 350, maxWait: 15000, countMs: 1200,              // the gap before the next sheet, the longest a sheet slides, GO after start
  lagMs: 2500, aheadMs: 300,                                // a drop may arrive this late, or this early, against the room's clock
  maxSheets: 400                                            // a round ends here (nobody gets near it)
};

export const PRINT_ORDERS = 'print-orders-v1';
export const SHEETS_PER_ORDER = 2;

function rand32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const tri = u => { const f = u - Math.floor(u); return 4 * Math.abs(f - 0.5) - 1; };

export function printOrders(seed) {
  const draw = rand32(seed ^ 0xd3c7f241);
  const rush = [25, 35, 45][Math.floor(draw() * 3)];
  const fine = [25, 35, 45][Math.floor(draw() * 3)];
  const quick = [4000, 4500, 5000][Math.floor(draw() * 3)];
  const orders = [
    { id: 'rush', name: 'Rush', summary: `${rush}% faster`, rule: `Sheets move ${rush}% faster.`, speed: 1 + rush / 100, color: 2 },
    { id: 'fine', name: 'Fine Cut', summary: `${fine}% tighter`, rule: `The perfect drop window is ${fine}% tighter.`, perfect: STACK.perfect * (1 - fine / 100), color: 0 },
    { id: 'quick', name: 'Quick Dry', summary: `${quick / 1000}s to drop`, rule: `Drop each sheet within ${quick / 1000} seconds.`, maxWait: quick, color: 3 },
  ];
  for (let index = orders.length - 1; index > 0; index--) {
    const other = Math.floor(draw() * (index + 1));
    [orders[index], orders[other]] = [orders[other], orders[index]];
  }
  return orders;
}

export function orderIndex(score) {
  return Math.floor(score / SHEETS_PER_ORDER);
}

// A fresh tower: the first sheet on the pedestal (it never moves)
export function newStack(seed, rules) {
  return {
    seed: seed >>> 0, n: 0, w: STACK.w, d: STACK.d, x: 0, z: 0, run: 0, over: false, side: sidesOf(seed),
    orders: rules === PRINT_ORDERS ? printOrders(seed) : [],
  };
}
// which end each sheet starts from (+1 or -1), from the seed
function sidesOf(seed) { const r = rand32(seed ^ 0x5eed), out = []; for (let i = 0; i < 64; i++) out.push(r() < 0.5 ? 1 : -1); return out; }
// the sliding sheet (number n + 1 on the tower): which way it slides, how far out, how fast
export function slideOf(st) {
  const axis = st.n % 2 ? 'z' : 'x', size = axis === 'x' ? st.w : st.d, amp = size + 0.3;   // it starts clear of the tower, so a late drop misses
  const order = st.orders[orderIndex(st.n) % st.orders.length];
  return {
    axis, size, amp, order, from: st.side[st.n % st.side.length],
    speed: Math.min(STACK.speedMax, STACK.speed0 + STACK.speedUp * st.n) * (order?.speed ?? 1),
    perfect: order?.perfect ?? STACK.perfect,
    maxWait: order?.maxWait ?? STACK.maxWait,
  };
}
// how far the sliding sheet's middle is from the top sheet's middle along its axis, `ms` after it appeared
export function offsetAt(st, ms) {
  const S = slideOf(st), u = Math.max(0, ms) / 1000 * S.speed / (4 * S.amp) + (S.from > 0 ? 0 : 0.5);
  return S.amp * tri(u);
}
// Drop the sliding sheet `ms` after it appeared (a whole number). Returns the cut: {ok, perfect, off, lost, keep}; the tower
// moves on (st.n, the top's size and middle). A miss ends the round (st.over).
export function drop(st, ms) {
  const S = slideOf(st);
  if (st.over || !Number.isInteger(ms) || ms < 0 || ms > S.maxWait) { st.over = true; return {ok: false, off: null}; }
  const off = offsetAt(st, ms), a = Math.abs(off);
  if (a <= S.perfect) {
    st.run++; st.n++;
    if (st.n >= STACK.maxSheets) st.over = true;
    if (st.run >= STACK.growAfter) { if (S.axis === 'x') st.w = Math.min(STACK.w, st.w + STACK.grow); else st.d = Math.min(STACK.d, st.d + STACK.grow); }
    return {ok: true, perfect: true, off, lost: 0, keep: S.size};
  }
  const keep = S.size - a;
  if (keep <= 0) { st.over = true; return {ok: false, off, lost: S.size, keep: 0}; }
  st.run = 0; st.n++;
  if (S.axis === 'x') { st.w = keep; st.x += off / 2; } else { st.d = keep; st.z += off / 2; }
  if (st.n >= STACK.maxSheets) st.over = true;
  return {ok: true, perfect: false, off, lost: a, keep};
}
// Replays a whole round: the drop times in order. Returns the tower and how many sheets stayed.
export function replayStack(seed, times, rules) {
  const st = newStack(seed, rules);
  for (const ms of times) { if (st.over) break; drop(st, ms); }
  return st;
}

export function verifyScorecard(seed, rules, { score, drops, ending }) {
  if (!Number.isInteger(score) || score < 1 || !Array.isArray(drops) || drops.length > STACK.maxSheets) return false;
  const state = newStack(seed, rules);
  for (const ms of drops) {
    if (state.over || !Number.isInteger(ms) || ms < 0 || ms > slideOf(state).maxWait) return false;
    drop(state, ms);
  }
  if (state.n !== score) return false;
  return state.over ? ending === 'closed' : ending === 'timeout';
}
// The room's clock check for one drop: `startAt` (the first sheet's GO on the room's clock), the drop times so far
// (including this one), and when the room heard it. The drop must not come before it could have happened, nor long after.
export function dropClock(startAt, times) { let t = startAt; for (let i = 0; i < times.length; i++) t += (i ? STACK.spawnMs : 0) + times[i]; return t; }
