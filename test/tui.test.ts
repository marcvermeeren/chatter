import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFeedLines, chatEscapeAction, headerBar, nextWizardStep, pluginContextCwd, rosterIdentity,
  viewRepoCwd,
} from '../src/board';
import { pluginInvocationContext } from '../src/herdr';
import { nextSetupStep } from '../src/setup';
import { manifestVersion, runUpdate } from '../src/update';
import {
  AGENT_FACES, agentAvatar, agentFace, authorHue, authorWithAvatar,
  clean, decodeKey, fg, stripAnsi, visWidth, wrap,
} from '../src/tui';
import type { MessageRow } from '../src/types';

test('terminal sanitization removes controls but preserves newlines', () => {
  assert.equal(clean('hello\x1b[31m red\r\nnext\x07'), 'hello[31m red\nnext');
});

test('wrapping and visible width handle ANSI independently', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
  assert.equal(visWidth('\x1b[1mhello\x1b[0m'), 5);
  assert.equal(stripAnsi('\x1b[1mhello\x1b[0m'), 'hello');
});

test('agent avatars are curated, fixed-width, and deterministic', () => {
  assert.equal(AGENT_FACES.length, 32);
  assert.equal(new Set(AGENT_FACES).size, AGENT_FACES.length);
  for (const face of AGENT_FACES) {
    assert.match(face, /^[\x20-\x7e]{5}$/);
    assert.equal(visWidth(face), 5);
  }
  assert.equal(agentFace('codex'), agentFace('codex'));
  assert.ok(new Set(['codex', 'claude', 'pi', 'opencode', 'gemini', 'cursor']
    .map(agentFace)).size >= 4);
});

test('agent avatars reuse the existing author color and remain legible without ANSI', () => {
  const name = 'codex';
  assert.ok(agentAvatar(name).startsWith(fg(authorHue(name))));
  assert.equal(stripAnsi(agentAvatar(name)), agentFace(name));
  assert.equal(stripAnsi(authorWithAvatar(name)), `${agentFace(name)} ${name}`);
  assert.equal(visWidth(authorWithAvatar(name)), 5 + 1 + name.length);
});

test('board roster and chat headers render the assigned avatar', () => {
  assert.equal(stripAnsi(rosterIdentity('codex', 'frontend')),
    `${agentFace('codex')} frontend · @codex`);
  const message: MessageRow = {
    id: 1,
    from_agent: 'codex',
    to_agent: '#chat',
    body: 'deploy is green',
    kind: 'chat',
    ref_id: null,
    created_at: '2026-01-01 09:41:00',
    delivered_at: null,
    read_at: null,
  };
  const rendered = buildFeedLines([message], 80, 'marc', 0).map(stripAnsi);
  assert.ok(rendered.some((line) =>
    line.startsWith(`  ${agentFace('codex')} codex · `)));
});

test('raw terminal keys decode into an explicit union', () => {
  assert.deepEqual(decodeKey('\x1b[A'), { type: 'up' });
  assert.deepEqual(decodeKey('x'), { type: 'text', text: 'x' });
  assert.deepEqual(decodeKey('toString'), { type: 'text', text: 'toString' });
  assert.deepEqual(decodeKey('\x1b[99~'), { type: 'other' });
});

test('setup and chat wizard state transitions stay explicit', () => {
  assert.equal(nextSetupStep(0), 1);
  assert.equal(nextSetupStep(1), 2);
  assert.equal(nextSetupStep(2), 3);
  assert.equal(nextSetupStep(3), 4);
  assert.equal(nextSetupStep(4), 5);
  assert.equal(nextSetupStep(5), 6);
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
  assert.equal(pluginContextCwd('{"workspace_cwd":"/repo/two","focused_pane_cwd":"/repo/one"}'), '/repo/one');
  assert.equal(pluginContextCwd('{"worktree":{"checkout_path":"/repo/three"},"workspace_cwd":"/repo/two"}'), '/repo/two');
  assert.deepEqual(pluginInvocationContext(
    '{"workspace_id":"w4","focused_pane_id":"w4:p2","focused_pane_cwd":"/repo/one"}',
  ), { workspaceId: 'w4', focusedPaneId: 'w4:p2', cwd: '/repo/one' });
});

test('explicit pane repository anchors win and invalid plugin context fails closed', () => {
  const context = '{"focused_pane_cwd":"/repo/context"}';
  assert.equal(viewRepoCwd('/repo/anchor', context, '/plugin/root'), '/repo/anchor');
  assert.equal(viewRepoCwd('', context, '/plugin/root'), null);
  assert.equal(viewRepoCwd(undefined, context, '/plugin/root'), '/repo/context');
  assert.equal(viewRepoCwd(undefined, '{}', '/plugin/root'), null);
  assert.equal(viewRepoCwd(undefined, undefined, '/direct/repo'), '/direct/repo');
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
