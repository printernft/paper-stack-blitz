import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { devnet, loadVerifiedChallenge, verifyDevnetCluster } from './proof.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_STEP_SUMMARY) {
  throw new Error('Run this step through the Paper Stack GitHub workflow.');
}
const cluster = 'https://api.devnet.solana.com';
const env = { ...process.env, STACK_DEVNET_RPC: cluster };
if (process.env.STACK_DEVNET_RPC && process.env.STACK_DEVNET_RPC !== cluster) {
  throw new Error('The GitHub proof job uses the public Solana devnet endpoint.');
}
await verifyDevnetCluster();
process.umask(0o077);

const payer = join(process.env.RUNNER_TEMP, 'paper-stack-test-payer.json');
const buffer = join(process.env.RUNNER_TEMP, 'paper-stack-deploy-buffer.json');
const binary = 'target/deploy/stack_seed.so';
const programKey = 'target/deploy/stack_seed-keypair.json';
const receiptPath = '.runtime/devnet-proof.json';
const programBytes = await readFile(binary);
const size = programBytes.length;
await stat(programKey);

execFileSync('solana-keygen', ['new', '--silent', '--no-bip39-passphrase', '--outfile', payer], { stdio: 'inherit' });
const address = execFileSync('solana-keygen', ['pubkey', payer], { encoding: 'utf8' }).trim();
const [programRent, executableRent] = await Promise.all([
  devnet('getMinimumBalanceForRentExemption', [size + 45]),
  devnet('getMinimumBalanceForRentExemption', [36]),
]);
if (![programRent, executableRent].every(rent => Number.isSafeInteger(rent) && rent > 0)) {
  throw new Error('Devnet did not return valid program rent estimates.');
}
// The loader refunds the upload buffer before charging program-data rent.
const needed = programRent + executableRent + 100_000_000;
if (!Number.isSafeInteger(needed) || needed <= 100_000_000) throw new Error('Devnet did not return a valid rent estimate.');

const fundMessage = `Fund ${address} with ${(needed / 1_000_000_000).toFixed(9)} SOL from a devnet faucet. The job waits up to 25 minutes.`;
console.log(fundMessage);
await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Devnet test payer\n\n${fundMessage}\n`);
const deadline = Date.now() + 25 * 60 * 1000;
let funded = false;
while (Date.now() < deadline) {
  const balance = await devnet('getBalance', [address, { commitment: 'confirmed' }]).catch(() => null);
  if (balance?.value >= needed) {
    funded = true;
    break;
  }
  await sleep(15_000);
}
if (!funded) throw new Error('The test payer did not reach the requested faucet balance in time.');

// Confirm one buffer write at a time to stay below the public RPC's rate limits.
const { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = await import('@solana/web3.js');
const loadKeypair = async file => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(file, 'utf8'))));
const payerKey = await loadKeypair(payer);
execFileSync('solana-keygen', ['new', '--silent', '--no-bip39-passphrase', '--outfile', buffer], { stdio: 'inherit' });
const bufferKey = await loadKeypair(buffer);
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const headerSize = 37;
const chunkSize = 1_000;
const bufferAccount = { pubkey: bufferKey.publicKey, isSigner: false, isWritable: true };
const authority = { pubkey: payerKey.publicKey, isSigner: true, isWritable: false };

async function account(publicKey, commitment, dataSlice) {
  const options = { encoding: 'base64', commitment };
  if (dataSlice) options.dataSlice = dataSlice;
  const result = await devnet('getAccountInfo', [publicKey.toBase58(), options]);
  return result.value;
}

async function sendConfirmed(instructions, signers, label, alreadyApplied) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const latest = await devnet('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const tx = new Transaction({ feePayer: payerKey.publicKey, recentBlockhash: latest.value.blockhash }).add(...instructions);
      tx.sign(...signers);
      const bytes = tx.serialize();
      if (bytes.length > 1232) throw new Error('Transaction exceeds Solana packet size.');
      const signature = await devnet('sendTransaction', [bytes.toString('base64'), {
        encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 4,
      }]);
      const confirmBy = Date.now() + 30_000;
      while (Date.now() < confirmBy) {
        await sleep(550);
        const statuses = await devnet('getSignatureStatuses', [[signature]]).catch(() => null);
        const status = statuses?.value?.[0];
        if (status?.err) throw new Error(`Devnet rejected ${label}: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
      }
      throw new Error(`Confirmation timed out for ${label}.`);
    } catch (error) {
      failure = error;
      if (await alreadyApplied().catch(() => false)) return;
      await sleep(700 * (attempt + 1));
    }
  }
  throw new Error(`${label} did not finish after three attempts.`, { cause: failure });
}

function readBuffer(info) {
  if (!info || info.owner !== loader.toBase58() || info.executable || info.data?.[1] !== 'base64') return null;
  const bytes = Buffer.from(info.data[0], 'base64');
  if (bytes.length !== size + headerSize || bytes.readUInt32LE(0) !== 1 || bytes[4] !== 1 ||
      !bytes.subarray(5, headerSize).equals(payerKey.publicKey.toBuffer())) return null;
  return bytes.subarray(headerSize);
}

const bufferRent = await devnet('getMinimumBalanceForRentExemption', [size + headerSize]);
if (!Number.isSafeInteger(bufferRent) || bufferRent <= 0 || bufferRent > programRent) {
  throw new Error('Devnet did not return a valid loader buffer rent estimate.');
}
await sendConfirmed([
  SystemProgram.createAccount({
    fromPubkey: payerKey.publicKey, newAccountPubkey: bufferKey.publicKey,
    lamports: bufferRent, space: size + headerSize, programId: loader,
  }),
  new TransactionInstruction({
    programId: loader, data: Buffer.alloc(4),
    keys: [bufferAccount, { ...authority, isSigner: false }],
  }),
], [payerKey, bufferKey], 'Create the program buffer', async () =>
  !!readBuffer(await account(bufferKey.publicKey, 'confirmed')));
const original = readBuffer(await account(bufferKey.publicKey, 'confirmed'));
if (!original) throw new Error('The confirmed devnet buffer does not match its expected authority or size.');
console.log(`Writing ${size} program bytes to the devnet buffer.`);

for (let offset = 0; offset < size; offset += chunkSize) {
  const chunk = programBytes.subarray(offset, offset + chunkSize);
  if (!original.subarray(offset, offset + chunk.length).equals(chunk)) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(1);
    header.writeUInt32LE(offset, 4);
    header.writeBigUInt64LE(BigInt(chunk.length), 8);
    await sendConfirmed([new TransactionInstruction({
      programId: loader, keys: [bufferAccount, authority], data: Buffer.concat([header, chunk]),
    })], [payerKey], `Write program bytes at offset ${offset}`, async () => {
      const current = await account(bufferKey.publicKey, 'confirmed', { offset: headerSize + offset, length: chunk.length });
      return current?.owner === loader.toBase58() && current.data?.[1] === 'base64' && Buffer.from(current.data[0], 'base64').equals(chunk);
    });
  }
  if ((offset / chunkSize + 1) % 25 === 0 || offset + chunk.length === size) {
    console.log(`Confirmed ${offset + chunk.length}/${size} program bytes.`);
  }
}

let finalizedBuffer;
for (let attempt = 0; attempt < 45; attempt += 1) {
  finalizedBuffer = readBuffer(await account(bufferKey.publicKey, 'finalized').catch(() => null));
  if (finalizedBuffer?.equals(programBytes)) break;
  await sleep(1_000);
}
if (!finalizedBuffer?.equals(programBytes)) throw new Error('The finalized buffer differs from the compiled program.');
console.log('The finalized devnet buffer matches the compiled program.');

const programAddress = (await loadKeypair(programKey)).publicKey;
try {
  execFileSync('solana', [
    '--url', cluster, '--keypair', payer, 'program', 'deploy',
    '--program-id', programKey, '--buffer', buffer, '--max-len', String(size),
  ], { stdio: 'inherit' });
} catch (error) {
  const executable = await account(programAddress, 'confirmed').catch(() => null);
  if (executable?.owner !== loader.toBase58() || !executable.executable) throw error;
  console.log(`Devnet confirms the program is executable at ${programAddress.toBase58()}.`);
}
execFileSync(process.execPath, ['scripts/devnet-request.mjs', '--send-devnet'], {
  stdio: 'inherit', env: { ...env, STACK_DEVNET_KEYPAIR: payer },
});
const challenge = await loadVerifiedChallenge(receiptPath);
await copyFile(receiptPath, 'devnet-proof.json');
await appendFile(process.env.GITHUB_STEP_SUMMARY, [
  '\n## Verified Paper Stack draw\n',
  `Day ${challenge.day}\n`,
  `Program \`${challenge.proof.program}\`\n`,
  `[Finalized MagicBlock callback](${challenge.proof.explorer})\n`,
].join('\n'));
