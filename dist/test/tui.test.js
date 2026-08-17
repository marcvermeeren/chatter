"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const board_1 = require("../src/board");
const setup_1 = require("../src/setup");
const update_1 = require("../src/update");
const tui_1 = require("../src/tui");
(0, node_test_1.default)('terminal sanitization removes controls but preserves newlines', () => {
    strict_1.default.equal((0, tui_1.clean)('hello\x1b[31m red\r\nnext\x07'), 'hello[31m red\nnext');
});
(0, node_test_1.default)('wrapping and visible width handle ANSI independently', () => {
    strict_1.default.deepEqual((0, tui_1.wrap)('one two three', 7), ['one two', 'three']);
    strict_1.default.equal((0, tui_1.visWidth)('\x1b[1mhello\x1b[0m'), 5);
    strict_1.default.equal((0, tui_1.stripAnsi)('\x1b[1mhello\x1b[0m'), 'hello');
});
(0, node_test_1.default)('raw terminal keys decode into an explicit union', () => {
    strict_1.default.deepEqual((0, tui_1.decodeKey)('\x1b[A'), { type: 'up' });
    strict_1.default.deepEqual((0, tui_1.decodeKey)('x'), { type: 'text', text: 'x' });
    strict_1.default.deepEqual((0, tui_1.decodeKey)('\x1b[99~'), { type: 'other' });
});
(0, node_test_1.default)('setup and chat wizard state transitions stay explicit', () => {
    strict_1.default.equal((0, setup_1.nextSetupStep)(0), 1);
    strict_1.default.equal((0, setup_1.nextSetupStep)(1), 2);
    strict_1.default.equal((0, setup_1.nextSetupStep)(2), 3);
    strict_1.default.equal((0, setup_1.nextSetupStep)(3), 4);
    strict_1.default.equal((0, board_1.nextWizardStep)('handle'), 'kind');
    strict_1.default.equal((0, board_1.nextWizardStep)('kind'), 'setup');
    strict_1.default.equal((0, board_1.nextWizardStep)('setup', { tab: false }), 'branch');
    strict_1.default.equal((0, board_1.nextWizardStep)('setup', { tab: true }), 'purpose');
    strict_1.default.equal((0, board_1.nextWizardStep)('purpose', { mode: 'spawn' }), 'confirm');
    strict_1.default.equal((0, board_1.nextWizardStep)('purpose', { mode: 'team' }), 'more');
});
(0, node_test_1.default)('Escape closes popups but only unwinds or hints in persistent chat panes', () => {
    strict_1.default.equal((0, board_1.chatEscapeAction)(false), 'close');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true, { transient: true }), 'clear-transient');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true), 'persistent-hint');
    strict_1.default.equal((0, board_1.chatEscapeAction)(true, { wizard: true }), 'cancel-wizard');
});
(0, node_test_1.default)('chat header omits inactive universe tabs', () => {
    const files = ['/state/repos/alpha-11111111/chatter.db', '/state/repos/beta-22222222/chatter.db'];
    strict_1.default.doesNotMatch((0, tui_1.stripAnsi)((0, board_1.headerBar)(files[0], 80)), /\[1 alpha\]/);
    strict_1.default.match((0, tui_1.stripAnsi)((0, board_1.headerBar)(files[0], 80, files)), /\[1 alpha\]/);
});
(0, node_test_1.default)('update helpers preserve the manifest and unsupported-source behavior', () => {
    strict_1.default.match((0, update_1.manifestVersion)(process.cwd()) ?? '', /^\d+\.\d+\.\d+$/);
    strict_1.default.deepEqual((0, update_1.runUpdate)({ source: {}, root: process.cwd() }), {
        ok: false,
        lines: [
            'chatter is not registered with Herdr',
            'install it:  herdr plugin install <owner>/<repo>',
            'or link this checkout:  herdr plugin link <path>',
        ],
    });
});
