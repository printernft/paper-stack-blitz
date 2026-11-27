import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, stat } from 'node:fs/promises';
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
const { size } = await stat(binary);
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

execFileSync('solana-keygen', ['new', '--silent', '--no-bip39-passphrase', '--outfile', buffer], { stdio: 'inherit' });
execFileSync('solana', [
  '--url', cluster, '--keypair', payer, 'program', 'deploy', binary,
  '--program-id', programKey, '--buffer', buffer, '--max-len', String(size), '--use-rpc',
], { stdio: 'inherit' });
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
