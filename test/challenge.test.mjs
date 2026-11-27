import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStackServer } from '../server.mjs';
import { discriminator, loadConfiguredChallenge, validateChallenge, verifyDevnetCluster, VRF_PROGRAM } from '../scripts/proof.mjs';
import { STACK, PRINT_ORDERS, newStack, drop, slideOf, printOrders, verifyScorecard } from '../public/stack.js';

const root = fileURLToPath(new URL('../test/', import.meta.url));
const day = Date.parse('2026-11-24T12:00:00Z');

test('two players share a seed and server scores and scorecards survive a restart', async () => {
  const dataDir = mkdtempSync(join(root, 'sandbox-'));
  let now = day;
  let server;
  async function start() {
    server = createStackServer({ now: () => now, dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  try {
    let base = await start();
    async function call(path, body) {
      const response = await fetch(base + path, body && {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, json: await response.json() };
    }
    const { json: challenge } = await call('/api/challenge');
    assert.equal(challenge.proof, null);
    assert.equal(challenge.rules, PRINT_ORDERS);
    assert.equal((await call('/api/challenge?id=old')).status, 404);
    const { json: shared } = await call(`/api/challenge?id=${challenge.id}`);
    assert.equal(shared.seed, challenge.seed);
    assert.equal(shared.rules, PRINT_ORDERS);
    const legacy = await call(`/api/challenge?id=practice-${challenge.day}`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.json.rules, undefined);
    const play = async (name, count) => {
      const { status, json: run } = await call('/api/start', { challenge: challenge.id });
      assert.equal(status, 201);
      const round = run.id;
      assert.equal((await call('/api/drop', { round, sheet: 0, ms: 0 })).status, 409);
      const st = newStack(challenge.seed, challenge.rules);
      let spawn = run.spawn;
      for (let sheet = 0; sheet < count; sheet += 1) {
        const slide = slideOf(st);
        const ms = Math.round(slide.amp / slide.speed * 1000);
        now = spawn + ms;
        const input = { round, sheet, ms };
        const placed = await call('/api/drop', input);
        assert.equal(placed.json.score, sheet + 1);
        assert.deepEqual(placed, await call('/api/drop', input));
        drop(st, ms);
        assert.equal(st.n, sheet + 1);
        spawn = placed.json.spawn;
      }
      assert.equal((await call('/api/score', { round, name })).status, 400);
      const limit = slideOf(st).maxWait;
      now = spawn + limit - 200;
      assert.equal((await call('/api/finish', { round })).status, 409);
      now = spawn + limit;
      assert.equal((await call('/api/finish', { round })).json.score, count);
      const scored = await call('/api/score', { round, name, score: 9999 });
      assert.equal(scored.status, 200);
      assert.equal(scored.json.receipt.score, count);
      assert.equal(scored.json.receipt.name, name);
      assert(verifyScorecard(challenge.seed, challenge.rules, scored.json.receipt));
      const changed = structuredClone(scored.json.receipt);
      changed.drops[0] = 0;
      assert.equal(verifyScorecard(challenge.seed, challenge.rules, changed), false);
      assert.notEqual(scored.json.receipt.id, round);
      assert.deepEqual(scored, await call('/api/score', { round, name: 'Duplicate' }));
      return scored.json.receipt;
    };
    const receipt = await play('PaperPilot', 1);
    await play('StackRunner', 7);
    await new Promise(resolve => server.close(resolve));
    base = await start();
    const { json } = await call('/api/challenge');
    assert.deepEqual(json.leaders, [{ name: 'StackRunner', score: 7 }, { name: 'PaperPilot', score: 1 }]);
    assert.deepEqual((await call(`/api/challenge?id=${challenge.id}&receipt=${receipt.id}`)).json.target, receipt);
    assert.equal((await call('/api/challenge?receipt=unknown')).json.target, null);
    now = day + 86400000;
    assert.equal((await call(`/api/challenge?receipt=${receipt.id}`)).json.target, null);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(join(dataDir, 'scores.ndjson'), { force: true });
    rmdirSync(dataDir);
  }
});

test('the same draw sets both the print order sequence and gameplay parameters', () => {
  const plans = Array.from({ length: 24 }, (_, seed) => printOrders(seed));
  assert.equal(new Set(plans.map(plan => plan.map(order => order.id).join(','))).size, 6);
  assert(new Set(plans.flatMap(plan => plan.filter(order => order.id === 'rush').map(order => order.speed))).size > 1);
  assert(new Set(plans.flatMap(plan => plan.filter(order => order.id === 'fine').map(order => order.perfect))).size > 1);
  assert(new Set(plans.flatMap(plan => plan.filter(order => order.id === 'quick').map(order => order.maxWait))).size > 1);
  const state = newStack(5, PRINT_ORDERS);
  assert.deepEqual(state.orders, printOrders(5));
  for (let index = 0; index < state.orders.length; index++) {
    const expected = state.orders[index];
    assert.equal(slideOf(state).order, expected);
    for (let sheet = 0; sheet < 2; sheet++) {
      const slide = slideOf(state);
      assert.equal(slide.order, expected);
      assert.equal(slide.maxWait, expected.maxWait ?? STACK.maxWait);
      assert.equal(slide.perfect, expected.perfect ?? STACK.perfect);
      const center = Math.round(slide.amp / slide.speed * 1000);
      assert.equal(drop(state, center).perfect, true);
    }
  }
  assert.equal(slideOf(state).order, state.orders[0]);
});

test('proof requires the matching account, finalized signature and nested MagicBlock callback', async testContext => {
  const proof = { program: 'A'.repeat(44), account: 'B'.repeat(44), callback: 'C'.repeat(88) };
  const dayIndex = day / 86400000 | 0;
  const raw = Buffer.alloc(45);
  discriminator('account:DailySeed').copy(raw);
  raw.writeUInt32LE(dayIndex, 8);
  raw[12] = 1;
  raw.writeUInt32LE(362385, 13);
  const info = { owner: proof.program, executable: false, data: [raw.toString('base64'), 'base64'] };
  const tx = {
    transaction: { signatures: [proof.callback], message: { accountKeys: [{ pubkey: proof.account, writable: true }] } },
    meta: { err: null, logMessages: [
      `Program ${VRF_PROGRAM} invoke [1]`, `Program ${proof.program} invoke [2]`,
      `Program log: STACK_SEED ${dayIndex} 362385`, `Program ${proof.program} success`, `Program ${VRF_PROGRAM} success`,
    ] },
  };
  assert.equal(validateChallenge(proof, info, tx).seed, 362385);
  assert.equal(validateChallenge(proof, info, tx).day, '2026-11-24');
  assert.throws(() => validateChallenge(proof, { ...info, owner: proof.account }, tx), /owner/);
  const fake = structuredClone(tx);
  fake.meta.logMessages[0] = `Program ${proof.account} invoke [1]`;
  assert.throws(() => validateChallenge(proof, info, fake), /inside the MagicBlock callback/);
  fake.meta.err = 'Failed';
  assert.throws(() => validateChallenge(proof, info, fake), /finalized callback/);
  const results = {
    getGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    getAccountInfo: { value: info },
    getTransaction: tx,
  };
  testContext.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method !== 'getGenesisHash') assert.equal(params[1].commitment, 'finalized');
    return new Response(JSON.stringify({ result: results[method] }));
  });
  const published = await loadConfiguredChallenge({ STACK_PROOF_JSON: JSON.stringify(proof), STACK_REQUIRE_VERIFIED: '1' });
  assert.deepEqual(published, validateChallenge(proof, info, tx));
});

test('judge startup rejects a missing proof or competing sources', async () => {
  assert.equal(await loadConfiguredChallenge({}), null);
  await assert.rejects(loadConfiguredChallenge({ STACK_REQUIRE_VERIFIED: '1' }), /needs a finalized/);
  await assert.rejects(loadConfiguredChallenge({ STACK_PROOF_FILE: 'proof.json', STACK_PROOF_JSON: '{}' }), /one judge proof source/);
  await assert.rejects(loadConfiguredChallenge({ STACK_PROOF_JSON: '{}' }), /public program, account and callback/);
});

test('RPC identity check rejects an endpoint outside Solana devnet', async testContext => {
  const fetch = testContext.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  })));
  await assert.rejects(verifyDevnetCluster(), /Solana devnet/);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).method, 'getGenesisHash');
  fetch.mock.mockImplementationOnce(async () => new Response(JSON.stringify({
    result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  })));
  await verifyDevnetCluster();
});
