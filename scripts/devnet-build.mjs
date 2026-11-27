import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const deploy = join(root, 'target', 'deploy');
const programKey = join(deploy, 'stack_seed-keypair.json');

function run(command, ...args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Install ${command} on the Anchor build host.`);
    throw error;
  }
}

run('anchor', '--version');
run('solana', '--version');
mkdirSync(deploy, { recursive: true });
if (!existsSync(programKey)) {
  run('solana-keygen', 'new', '--no-bip39-passphrase', '--silent', '--outfile', programKey);
}
run('anchor', 'keys', 'sync');
run('anchor', 'build');

const idl = JSON.parse(readFileSync(join(root, 'target', 'idl', 'stack_seed.json'), 'utf8'));
const size = statSync(join(deploy, 'stack_seed.so')).size;
if (!idl.address || size === 0) throw new Error('Anchor did not produce a deployable program and IDL.');
console.log(JSON.stringify({ program: idl.address, programSizeBytes: size }, null, 2));
