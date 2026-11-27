import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VRF_PROGRAM = 'Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz';
export const DEFAULT_QUEUE = 'Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh';
export const DEVNET_RPC_URL = process.env.STACK_DEVNET_RPC ?? 'https://api.devnet.solana.com';
const devnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8);
const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function validateChallenge({ program, account, callback }, data, tx) {
  if (![program, account, callback].every(value => typeof value === 'string' && base58.test(value))) {
    throw new Error('Use base58 program, account and callback IDs.');
  }
  if (program.length < 32 || program.length > 44 || account.length < 32 || account.length > 44 || callback.length < 64 || callback.length > 88) {
    throw new Error('Invalid program, account or callback ID length.');
  }
  if (!data || data.owner !== program || data.executable || data.data?.[1] !== 'base64') throw new Error('Invalid seed account owner.');
  const bytes = Buffer.from(data.data[0], 'base64');
  if (bytes.length !== 45 || !bytes.subarray(0, 8).equals(discriminator('account:DailySeed')) || bytes[12] !== 1) {
    throw new Error('The daily seed account has no fulfilled callback.');
  }
  const dayIndex = bytes.readUInt32LE(8);
  const seed = bytes.readUInt32LE(13);
  const keys = tx?.transaction?.message?.accountKeys ?? [];
  const writable = keys.some(key => key.pubkey === account && key.writable);
  if (tx?.meta?.err !== null || !tx.transaction.signatures.includes(callback) || !writable) {
    throw new Error('The finalized callback does not match the seed account.');
  }
  const stack = [];
  let matched = false;
  for (const line of tx.meta.logMessages ?? []) {
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invocation) {
      stack.length = Number(invocation[2]) - 1;
      stack.push(invocation[1]);
    } else if (/^Program [1-9A-HJ-NP-Za-km-z]+ (success|failed:)/.test(line)) {
      stack.pop();
    } else if (stack.at(-1) === program && stack.at(-2) === VRF_PROGRAM && line === `Program log: STACK_SEED ${dayIndex} ${seed}`) {
      matched = true;
    }
  }
  if (!matched) throw new Error('The matching seed was not emitted inside the MagicBlock callback.');
  const day = new Date(dayIndex * 86400000).toISOString().slice(0, 10);
  return { id: `${day}-${account}`, day, seed, proof: {
    account, program, callback, explorer: `https://explorer.solana.com/tx/${callback}?cluster=devnet`,
  } };
}

export async function devnet(method, params) {
  const response = await fetch(DEVNET_RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Devnet RPC HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.error) throw new Error(`Devnet RPC rejected ${method}.`);
  return envelope.result;
}

export async function verifyDevnetCluster() {
  const genesis = await devnet('getGenesisHash', []);
  if (genesis !== devnetGenesis) throw new Error('The RPC did not identify itself as Solana devnet.');
}

export async function verifyChallengeReceipt(proof) {
  if (!proof || ![proof.program, proof.account, proof.callback].every(value => typeof value === 'string' && base58.test(value))) {
    throw new Error('Provide public program, account and callback addresses in the devnet proof.');
  }
  await verifyDevnetCluster();
  const [info, tx] = await Promise.all([
    devnet('getAccountInfo', [proof.account, { encoding: 'base64', commitment: 'finalized' }]),
    devnet('getTransaction', [proof.callback, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]),
  ]);
  return validateChallenge(proof, info?.value, tx);
}

export async function loadVerifiedChallenge(path) {
  return verifyChallengeReceipt(JSON.parse(await readFile(path, 'utf8')));
}

export async function loadConfiguredChallenge(env = process.env) {
  const { STACK_PROOF_FILE: file, STACK_PROOF_JSON: json, STACK_REQUIRE_VERIFIED: required } = env;
  if (file && json) throw new Error('Set one judge proof source: STACK_PROOF_FILE or STACK_PROOF_JSON.');
  if (file) return loadVerifiedChallenge(file);
  if (json) return verifyChallengeReceipt(JSON.parse(json));
  if (required === '1') throw new Error('Verified judge mode needs a finalized MagicBlock devnet proof.');
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/proof.mjs path-to-proof.json');
  console.log(JSON.stringify(await loadVerifiedChallenge(process.argv[2]), null, 2));
}
