const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const exportsForTest = {};
new Function('require', 'exports', ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/pickerIcons.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } },
).outputText)(() => ({ Uri: { parse: value => ({ toString: () => value }) } }), exportsForTest);

for (const emoji of ['😃', '🧑‍🚒', '🧯', '❤️‍🔥', '🔥', '<script>&"\'']) {
    test(`SVG icon preserves all code points and escapes markup: ${emoji}`, () => {
        const icon = exportsForTest.createEmojiIconProvider()(emoji).toString();
        assert(icon.startsWith('data:image/svg+xml,'));
        const svg = decodeURIComponent(icon.slice('data:image/svg+xml,'.length));
        const text = svg.match(/<text\b[^>]*>(.*?)<\/text>/)[1];
        assert.match(text, /^(?:&#x[0-9a-f]+;)+$/);
        const decoded = text.replace(/&#x([0-9a-f]+);/g, (_, cp) => String.fromCodePoint(parseInt(cp, 16)));
        assert.equal(decoded, emoji);
        assert(svg.includes('font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"'));
    });
}

test('icons are reused by Unicode glyph, while separate providers own separate caches', () => {
    const first = exportsForTest.createEmojiIconProvider();
    const second = exportsForTest.createEmojiIconProvider();
    assert.equal(first('😃'), first('😃'));
    assert.notEqual(first('😃'), first('🔥'));
    assert.notEqual(first('😃'), second('😃'));
});
