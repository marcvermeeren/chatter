#!/usr/bin/env node
'use strict';

// Public-surface contract: a migration must not silently drop a command,
// hook, action, event, pane entrypoint, or documented command.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const entry = process.env.CHATTER_ENTRY || path.join(root, 'dist', 'bin', 'chatter.js');
const sourceEntry = process.env.CHATTER_SOURCE_ENTRY || path.join(root, 'bin', 'chatter.ts');

const expectedCommands = [
  'agents', 'send', 'inbox', 'post', 'chat', 'note', 'notes', 'search',
  'resolve', 'ask', 'answer', 'questions', 'task', 'handoff', 'whoami',
  'iam', 'log', 'stats', 'setup', 'brief', 'update', 'data', 'purge',
  'spawn', 'role', 'forget',
];
const expectedHooks = [
  '_startup', '_flush', '_reap', '_open_board', '_open_chat',
  '_open_chat_tab', '_setup_action', '_setup_wizard', 'board',
  '_chat_view', 'doctor',
];
const expectedManifestEntrypoints = [
  '_startup', '_flush', '_reap', '_reap', '_open_board', '_open_chat',
  '_open_chat_tab', '_setup_action', '_setup_wizard', 'board', '_chat_view',
];

function registryKeys(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\}(?: as const(?: satisfies [^;]+)?)?;`));
  if (!match) throw new Error(`could not find ${name} registry in ${sourceEntry}`);
  return [...match[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);
}

function assertSame(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} changed\nexpected: ${expected.join(', ')}\nactual:   ${actual.join(', ')}`);
  }
}

const source = fs.readFileSync(sourceEntry, 'utf8');
assertSame('COMMANDS', registryKeys(source, 'COMMANDS'), expectedCommands);
assertSame('HOOKS', registryKeys(source, 'HOOKS'), expectedHooks);

const manifest = fs.readFileSync(path.join(root, 'herdr-plugin.toml'), 'utf8');
const manifestEntrypoints = [...manifest.matchAll(/^command = \["node", "--no-warnings", "[^"]+", "([^"]+)"\]$/gm)]
  .map((m) => m[1]);
assertSame('manifest entrypoints', manifestEntrypoints, expectedManifestEntrypoints);

const help = execFileSync(process.execPath, ['--no-warnings', entry, 'help'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: os.tmpdir(),
    HERDR_PLUGIN_CONFIG_DIR: os.tmpdir(),
    HERDR_BIN_PATH: '/nonexistent-herdr',
  },
});
for (const command of expectedCommands.filter((name) => name !== 'search')) {
  if (!help.includes(`chatter ${command}`)) throw new Error(`help no longer documents chatter ${command}`);
}

console.log(`surface intact: ${expectedCommands.length} commands, ${expectedHooks.length} hooks, ${expectedManifestEntrypoints.length} manifest entrypoints`);
