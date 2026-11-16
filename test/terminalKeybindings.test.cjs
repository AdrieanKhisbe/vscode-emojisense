const assert = require('node:assert/strict');
const { test } = require('node:test');
const { contributes } = require('../package.json');

for (const name of ['quickEmoji', 'quickEmojitext']) {
    test(`${name} terminal and editor shortcuts stay aligned on every platform`, () => {
        const editor = contributes.keybindings.find(binding => binding.command === `emojisense.${name}`);
        const terminal = contributes.keybindings.find(binding => binding.command === `emojisense.${name}Terminal`);
        assert.equal(editor.when, 'editorTextFocus');
        assert.equal(terminal.when, 'terminalFocus');
        assert.equal(editor.linux, name === 'quickEmoji' ? 'ctrl+alt+i' : 'shift+ctrl+alt+i');
        for (const platform of ['mac', 'linux', 'win']) {
            assert.equal(terminal[platform] ?? terminal.key, editor[platform] ?? editor.key, platform);
        }
    });
}
