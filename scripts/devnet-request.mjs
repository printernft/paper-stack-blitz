import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devnet, discriminator, DEFAULT_QUEUE, DEVNET_RPC_URL, VRF_PROGRAM, validateChallenge, verifyDevnetCluster } from './proof.mjs';

const [mode, requestedDay, ...extraArgs] = process.argv.slice(2);
if (!['--prepare', '--send-devnet', '--recover-devnet'].includes(mode) || extraArgs.length) {
  throw new Error('Use --prepare, --send-devnet or --recover-devnet, optionally followed by a UTC date (YYYY-MM-DD).');
}
const today = new Date().toISOString().slice(0, 10);
const date = requestedDay ?? today;
const midnight = new Date(`${date}T00:00:00Z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight.getTime()) || midnight.getTime() < 0 || midnight.toISOString().slice(0, 10) !== date) {
  throw new Error('Use a valid UTC date (YYYY-MM-DD).');
}
const source = await readFile(new URL('../programs/stack-seed/src/lib.rs', import.meta.url), 'utf8');
const config = await readFile(new URL('../Anchor.toml', import.meta.url), 'utf8');
const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(source)?.[1];
const configured = /^stack_seed\s*=\s*"([1-9A-HJ-NP-Za-km-z]+)"/m.exec(config)?.[1];
if (!declared || declared !== configured) throw new Error('Sync the program address in the Rust source and Anchor.toml.');

const web3 = await import(process.env.STACK_WEB3_ENTRY
  ? pathToFileURL(resolve(process.env.STACK_WEB3_ENTRY)).href : '@solana/web3.js');
const { PublicKey, Connection, Keypair, Transaction, TransactionInstruction, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } = web3;
const program = new PublicKey(declared);
const day = midnight.getTime() / 86400000;
const dayBytes = Buffer.alloc(4);
dayBytes.writeUInt32LE(day);
const [daily] = PublicKey.findProgramAddressSync([Buffer.from('day'), dayBytes], program);
const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from('identity')], program);
const addresses = { program: program.toBase58(), account: daily.toBase58() };
const template = declared === 'Fg6PaFpoGXkYsidMpWxTWqkZp6W2BeZ7FEfcYkgMQhg';
console.log(JSON.stringify({ day: date, ...addresses, template }, null, 2));
if (mode === '--prepare') process.exit(0);
if (template) throw new Error('Set a deployment address with anchor keys sync before requesting or recovering a proof.');

await verifyDevnetCluster();
const rpc = new Connection(DEVNET_RPC_URL, 'confirmed');
const executable = await rpc.getAccountInfo(program);
if (!executable?.executable) throw new Error('Deploy the program to Solana devnet first.');
const original = await rpc.getAccountInfo(daily);
if (!original) {
  if (mode === '--recover-devnet' || date !== today) throw new Error(`No seed request exists on devnet for ${date}.`);
  const idl = JSON.parse(await readFile(new URL('../target/idl/stack_seed.json', import.meta.url), 'utf8'));
  if (idl.address !== declared) throw new Error('Rebuild the IDL for the declared program address.');
  const wallet = process.env.STACK_DEVNET_KEYPAIR;
  if (!wallet) throw new Error('Set STACK_DEVNET_KEYPAIR to a dedicated devnet payer file.');
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(wallet, 'utf8'))));
  const accounts = {
    payer: payer.publicKey, daily, oracle_queue: new PublicKey(DEFAULT_QUEUE),
    system_program: SystemProgram.programId, program_identity: programIdentity,
    vrf_program: new PublicKey(VRF_PROGRAM), slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY,
  };
  const instruction = idl.instructions.find(ix => ix.name === 'request_seed');
  if (!instruction) throw new Error('Build the current stack-seed IDL before requesting a seed.');
  const keys = instruction.accounts.map(meta => {
    const accountName = meta.name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const pubkey = accounts[accountName];
    if (!pubkey) throw new Error(`Unexpected request account ${meta.name}.`);
    return { pubkey, isWritable: !!meta.writable, isSigner: !!meta.signer };
  });
  const tx = new Transaction().add(new TransactionInstruction({
    programId: program, keys, data: Buffer.concat([discriminator('global:request_seed'), dayBytes]),
  }));
  const request = await rpc.sendTransaction(tx, [payer]);
  console.log(`Request: https://explorer.solana.com/tx/${request}?cluster=devnet`);
}

for (let attempt = 0; attempt < 26; attempt += 1) {
  const result = await devnet('getAccountInfo', [addresses.account, { encoding: 'base64', commitment: 'finalized' }]);
  const info = result?.value;
  if (info?.data?.[0] && Buffer.from(info.data[0], 'base64')[12] === 1) {
    const candidates = await devnet('getSignaturesForAddress', [addresses.account, { commitment: 'finalized', limit: 6 }]);
    for (const { signature, err } of candidates) {
      if (err) continue;
      const transaction = await devnet('getTransaction', [signature, {
        encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0,
      }]);
      const proof = { ...addresses, callback: signature };
      let challenge;
      try { challenge = validateChallenge(proof, info, transaction); }
      catch { continue; }
      const output = resolve('.runtime/devnet-proof.json');
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(proof, null, 2) + '\n');
      console.log(`Proof: ${challenge.proof.explorer}`);
      process.exit(0);
    }
  }
  await new Promise(resolve => setTimeout(resolve, 2500));
}
throw new Error('The callback has not finalized. Re-run later to recover the existing request.');
