import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`artifact verification failed: ${message}`);
  process.exitCode = 1;
}

if (Object.keys(pkg.dependencies ?? {}).length !== 0) fail('runtime dependencies must remain empty');

for (const file of ['bin/chatter.js', ...readdirSync(join(root, 'src')).filter((name) => name.endsWith('.js')).map((name) => `src/${name}`)]) {
  const built = join(root, 'dist', file);
  if (!existsSync(built) || !statSync(built).isFile()) fail(`missing generated file ${relative(root, built)}`);
}

if (!existsSync(join(root, 'dist', 'bin', 'chatter.js'))) fail('compiled CLI entrypoint is missing');

if (!process.exitCode) console.log('artifacts verified: zero runtime dependencies and complete dist output');
