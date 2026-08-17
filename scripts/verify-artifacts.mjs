import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`artifact verification failed: ${message}`);
  process.exitCode = 1;
}

if (Object.keys(pkg.dependencies ?? {}).length !== 0) fail('runtime dependencies must remain empty');

function filesBelow(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? filesBelow(file) : [file];
  });
}

const applicationJs = [...filesBelow(join(root, 'bin')), ...filesBelow(join(root, 'src'))]
  .filter((file) => file.endsWith('.js'));
if (applicationJs.length) fail(`application JavaScript exists outside dist: ${applicationJs.map((file) => relative(root, file)).join(', ')}`);

const sourceFiles = [
  ...filesBelow(join(root, 'bin')).filter((file) => file.endsWith('.ts')),
  ...filesBelow(join(root, 'src')).filter((file) => file.endsWith('.ts')),
  ...filesBelow(join(root, 'test')).filter((file) => file.endsWith('.test.ts')),
];
const expected = sourceFiles.map((file) => relative(root, file).replace(/\.ts$/, '.js')).sort();
const actual = filesBelow(join(root, 'dist')).map((file) => relative(join(root, 'dist'), file)).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  fail(`dist file set differs from TypeScript sources\nexpected: ${expected.join(', ')}\nactual: ${actual.join(', ')}`);
}

const manifest = readFileSync(join(root, 'herdr-plugin.toml'), 'utf8');
const manifestVersion = manifest.match(/^version = "([^"]+)"$/m)?.[1];
if (manifestVersion !== pkg.version) fail(`package version ${pkg.version} differs from manifest ${manifestVersion}`);
for (const match of manifest.matchAll(/^command = \["node", "--no-warnings", "([^"]+)"/gm)) {
  const target = match[1];
  if (!target || !existsSync(join(root, target))) fail(`manifest target does not exist: ${target}`);
}

const launcher = readFileSync(join(root, 'bin', 'chatter'), 'utf8');
if (!launcher.includes('dist/bin/chatter.js')) fail('launcher does not target the compiled entrypoint');

const distDiff = spawnSync('git', ['diff', '--exit-code', '--', 'dist'], { cwd: root, encoding: 'utf8' });
if (distDiff.status !== 0) fail('committed dist differs from a clean build');

if (!process.exitCode) console.log(`artifacts verified: ${actual.length} generated files, zero runtime dependencies, all manifest targets valid`);
