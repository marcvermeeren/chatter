import assert from 'node:assert/strict';
import test from 'node:test';
import { chatEscapeAction, headerBar, nextWizardStep, pluginContextCwd } from '../src/board';
import { nextSetupStep } from '../src/setup';
import { manifestVersion, runUpdate } from '../src/update';
import { clean, decodeKey, stripAnsi, visWidth, wrap } from '../src/tui';

test('terminal sanitization removes controls but preserves newlines', () => {
  assert.equal(clean('hello\x1b[31m red\r\nnext\x07'), 'hello[31m red\nnext');
});

test('wrapping and visible width handle ANSI independently', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
  assert.equal(visWidth('\x1b[1mhello\x1b[0m'), 5);
  assert.equal(stripAnsi('\x1b[1mhello\x1b[0m'), 'hello');
});

test('raw terminal keys decode into an explicit union', () => {
  assert.deepEqual(decodeKey('\x1b[A'), { type: 'up' });
  assert.deepEqual(decodeKey('x'), { type: 'text', text: 'x' });
  assert.deepEqual(decodeKey('\x1b[99~'), { type: 'other' });
});

test('setup and chat wizard state transitions stay explicit', () => {
  assert.equal(nextSetupStep(0), 1);
  assert.equal(nextSetupStep(1), 2);
  assert.equal(nextSetupStep(2), 3);
  assert.equal(nextSetupStep(3), 4);
  assert.equal(nextWizardStep('handle'), 'kind');
  assert.equal(nextWizardStep('kind'), 'setup');
  assert.equal(nextWizardStep('setup', { tab: false }), 'branch');
  assert.equal(nextWizardStep('setup', { tab: true }), 'purpose');
  assert.equal(nextWizardStep('purpose', { mode: 'spawn' }), 'confirm');
  assert.equal(nextWizardStep('purpose', { mode: 'team' }), 'more');
});

test('Escape closes popups but only unwinds or hints in persistent chat panes', () => {
  assert.equal(chatEscapeAction(false), 'close');
  assert.equal(chatEscapeAction(true, { transient: true }), 'clear-transient');
  assert.equal(chatEscapeAction(true), 'persistent-hint');
  assert.equal(chatEscapeAction(true, { wizard: true }), 'cancel-wizard');
});

test('view header names only its repository', () => {
  const header = stripAnsi(headerBar('/state/repos/alpha-11111111/chatter.db', 80));
  assert.match(header, /#alpha/);
  assert.doesNotMatch(header, /\[\d+ /);
});

test('plugin views require an explicit focused repository context', () => {
  assert.equal(pluginContextCwd('{}'), null);
  assert.equal(pluginContextCwd('not-json'), null);
  assert.equal(pluginContextCwd('{"focused_pane_cwd":"/repo/one"}'), '/repo/one');
  assert.equal(pluginContextCwd('{"workspace_cwd":"/repo/two","focused_pane_cwd":"/repo/one"}'), '/repo/two');
  assert.equal(pluginContextCwd('{"worktree":{"checkout_path":"/repo/three"},"workspace_cwd":"/repo/two"}'), '/repo/three');
});

test('update helpers preserve the manifest and unsupported-source behavior', () => {
  assert.match(manifestVersion(process.cwd()) ?? '', /^\d+\.\d+\.\d+$/);
  assert.deepEqual(runUpdate({ source: {}, root: process.cwd() }), {
    ok: false,
    lines: [
      'chatter is not registered with Herdr',
      'install it:  herdr plugin install <owner>/<repo>',
      'or link this checkout:  herdr plugin link <path>',
    ],
  });
});
