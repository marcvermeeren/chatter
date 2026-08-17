import assert from 'node:assert/strict';
import test from 'node:test';
import { headerBar } from '../src/board';
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

test('chat header omits inactive universe tabs', () => {
  const files = ['/state/repos/alpha-11111111/chatter.db', '/state/repos/beta-22222222/chatter.db'];
  assert.doesNotMatch(stripAnsi(headerBar(files[0]!, 80)), /\[1 alpha\]/);
  assert.match(stripAnsi(headerBar(files[0]!, 80, files)), /\[1 alpha\]/);
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
