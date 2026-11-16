const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

// Exercise the actual TypeScript implementation without installing a VS Code host.
const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/quickEmoji.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } },
).outputText;

// Deliberately put fuzzy matches before prefixes and the exact match.
const emojis = [
    { name: 'sweat_smile', emoji: '😅', description: 'grinning face with sweat' },
    { name: 'smile_cat', emoji: '😸', description: 'grinning cat with smiling eyes' },
    { name: 'smiley', emoji: '😃', description: 'grinning face with big eyes' },
    { name: 'smile', emoji: '😄', description: 'grinning face with smiling eyes' },
    { name: 'cat', emoji: '🐱', description: 'cat face' },
    { name: '+1', emoji: '👍', description: 'thumbs up' },
    { name: 'thumbsup', emoji: '👍', description: 'thumbs up' },
];
const originalNames = emojis.map(emoji => emoji.name);
const matching = {};
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/pickerMatching.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText)(matching);

function createHistoryState(initial = []) {
    const values = new Map([['picker.history', [...initial]]]);
    return {
        get: (key, fallback) => values.get(key) ?? fallback,
        update: async (key, value) => { values.set(key, [...value]); },
        get names() { return values.get('picker.history'); },
    };
}

// Baseline regressions use the minimum supported host; SVG cases opt into newer versions.
function openPicker({ settings = {}, property = 'emoji', destination = 'editor', dataset = emojis, historyState = createHistoryState(), showError, vscodeVersion = '1.75.0' } = {}) {
    let onChange;
    let onAccept;
    let onHide;
    let onButton;
    let onItemButton;
    let items = [];
    let inputValue = '';
    let valueUpdates = 0;
    let activeItems = [];
    let itemUpdates = 0;
    let focusUpdates = 0;
    let disposed = false;
    let activeSubscriptions = 0;
    const insertions = [];
    const terminalWrites = [];
    const clipboardWrites = [];
    const commands = [];
    const commandHandlers = new Map();
    const contexts = new Map();
    const warnings = [];
    const messages = [];
    const copyFeedbackTimers = new Map();
    let timerId = 0;
    const subscribe = () => {
        activeSubscriptions++;
        let disposed = false;
        return { dispose() {
            if (!disposed) activeSubscriptions--;
            disposed = true;
        } };
    };
    const picker = {
        get items() { return items; },
        set items(value) {
            items = value;
            activeItems = value.slice(0, 1);
            itemUpdates++;
        },
        get activeItems() { return activeItems; },
        set activeItems(value) { activeItems = value; focusUpdates++; },
        selectedItems: [],
        get value() { return inputValue; },
        set value(value) {
            if (value !== inputValue) {
                inputValue = value;
                valueUpdates++;
                onChange?.(value);
            }
        },
        onDidChangeValue(callback) { onChange = callback; return subscribe(); },
        onDidAccept(callback) { onAccept = callback; return subscribe(); },
        onDidHide(callback) { onHide = callback; return subscribe(); },
        onDidTriggerButton(callback) { onButton = callback; return subscribe(); },
        onDidTriggerItemButton(callback) { onItemButton = callback; return subscribe(); },
        show() { if (showError) throw showError; },
        hide() { onHide(); },
        dispose() { disposed = true; },
    };
    const api = {
        version: vscodeVersion,
        Uri: { parse: value => ({ toString: () => value }) },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        env: { clipboard: { writeText: async text => { clipboardWrites.push(text); } } },
        workspace: {
            getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
        },
        window: {
            showWarningMessage: async message => { messages.push(message); },
            createQuickPick: () => picker,
            activeTextEditor: {
                document: { uri: {} },
                selection: { active: {} },
                edit: async callback => {
                    callback({ insert: (_, text) => insertions.push(text) });
                    return true;
                },
            },
            activeTerminal: { sendText: (text, addNewLine) => terminalWrites.push({ text, addNewLine }) },
        },
        commands: {
            registerCommand(command, handler) {
                assert(!commandHandlers.has(command));
                commandHandlers.set(command, handler);
                const subscription = subscribe();
                return { dispose() { commandHandlers.delete(command); subscription.dispose(); } };
            },
            executeCommand: async (command, ...args) => {
                if (command === 'setContext') {
                    contexts.set(args[0], args[1]);
                } else if (commandHandlers.has(command)) {
                    return commandHandlers.get(command)(...args);
                } else {
                    commands.push(command);
                }
            },
        },
    };
    const exports = {};
    new Function('require', 'exports', 'console', 'setTimeout', 'clearTimeout', code)(name => {
        if (name === './pickerMatching') return matching;
        if (name === './pickerIcons') {
            const icons = {};
            new Function('require', 'exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/pickerIcons.ts'), 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
            }).outputText)(() => api, icons);
            return icons;
        }
        assert.equal(name, 'vscode');
        return api;
    }, exports, { warn: (...args) => warnings.push(args) }, (callback, delay) => {
        const id = ++timerId;
        copyFeedbackTimers.set(id, { callback, delay });
        return id;
    }, id => copyFeedbackTimers.delete(id));
    const done = exports.quickEmoji({ emojis: dataset.map(emoji => ({ tags: [], ...emoji })) }, historyState)(property, destination)();

    return {
        picker, done, api, insertions, terminalWrites, clipboardWrites, commands, commandHandlers, contexts, historyState, warnings, messages, copyFeedbackTimers,
        resetCopyFeedback() {
            for (const [id, { callback }] of [...copyFeedbackTimers]) {
                copyFeedbackTimers.delete(id);
                callback();
            }
        },
        get names() { return picker.items.map(item => item.emoji.name); },
        get itemUpdates() { return itemUpdates; },
        get focusUpdates() { return focusUpdates; },
        get valueUpdates() { return valueUpdates; },
        get hasChangeHandler() { return !!onChange; },
        get disposed() { return disposed; },
        get activeSubscriptions() { return activeSubscriptions; },
        change(value) {
            // Simulate native focus before notifying the extension. Native fuzzy
            // filtering/rendering itself is outside the scope of these tests.
            activeItems = items.slice(0, 1);
            picker.value = value;
        },
        select(name) { activeItems = [items.find(item => item.emoji.name === name)]; },
        toggleDescriptions() { onButton(picker.buttons[0]); },
        toggleInsertionMode() { onButton(picker.buttons[2]); },
        toggleSearch() { onButton(picker.buttons[1]); },
        copySelection(item = picker.activeItems[0]) {
            if (item) return onItemButton({ item, button: item.buttons[0] });
        },
        async accept() {
            picker.selectedItems = activeItems;
            onAccept();
            await done;
        },
        async cancel() { picker.hide(); await done; },
    };
}

const combinations = [
    { exact: false, prefix: false, expected: originalNames, focused: undefined },
    {
        exact: true, prefix: false,
        expected: ['smile', 'sweat_smile', 'smile_cat', 'smiley', 'cat', '+1', 'thumbsup'],
        focused: 'smile',
    },
    {
        exact: false, prefix: true,
        expected: ['smile_cat', 'smiley', 'smile', 'sweat_smile', 'cat', '+1', 'thumbsup'],
        focused: 'smile_cat',
    },
    {
        exact: true, prefix: true,
        expected: ['smile', 'smile_cat', 'smiley', 'sweat_smile', 'cat', '+1', 'thumbsup'],
        focused: 'smile',
    },
];

test('tags are appended to readable descriptions for native hashtag filtering', async () => {
    const session = openPicker({ dataset: [{
        name: 'smiley', emoji: '😃', description: 'grinning face with big eyes', tags: ['happy', 'joy', 'haha'],
    }] });
    const item = session.picker.items[0];
    assert.equal(item.description, ':smiley: · grinning face with big eyes · #happy #joy #haha');
    assert.equal(item.label, '😃');
    assert.equal(item.detail, undefined);
    assert.equal(item.tooltip, undefined);
    assert.equal(session.picker.matchOnDetail, false);
    const originalItems = session.picker.items;
    session.change('#happy');
    assert.equal(session.picker.value, '#happy');
    assert.equal(session.picker.items, originalItems);
    assert.equal(session.picker.title, '😃 Emoji Picker');
    assert.equal(session.picker.buttons.length, 3);
    assert.equal(item.description, ':smiley: · grinning face with big eyes · #happy #joy #haha');
    session.change('#');
    assert.equal(session.picker.items, originalItems); // No tag chooser or custom tag filtering.
    await session.cancel();
});

for (const ignoreSpaces of [true, false]) {
    test(`tags match independently of text position with ignoreSpaces=${ignoreSpaces}`, async t => {
        const session = openPicker({ settings: { 'picker.ignoreSpaces': ignoreSpaces }, dataset: [
            { name: 'smiley', emoji: '😃', description: 'grinning face with big eyes', tags: ['happy', 'joy'] },
            { name: 'cat', emoji: '🐱', description: 'cat face', tags: ['pet'] },
            { name: 'tada', emoji: '🎉', description: 'party popper', tags: ['happy'] },
        ] });
        t.after(() => session.cancel());
        for (const query of ['#happy face', 'face #happy', '#joy face #happy', '#happy #joy face']) {
            session.change(query);
            assert.equal(session.picker.value, query);
            assert.deepEqual(session.picker.items.filter(item => item.alwaysShow).map(item => item.emoji.name), ['smiley']);
        }
        session.change('#happy #joy');
        assert.deepEqual(session.picker.items.filter(item => item.alwaysShow).map(item => item.emoji.name), ['smiley']);
        session.change('#happy missing');
        assert(session.picker.items.every(item => !item.alwaysShow));
        session.change('#happy face');
        session.toggleSearch();
        assert(session.picker.items.every(item => !item.alwaysShow));
        session.toggleSearch();
        assert.equal(session.picker.items.find(item => item.emoji.name === 'smiley').alwaysShow, true);
        session.change('face');
        assert(session.picker.items.every(item => !item.alwaysShow));
    });
}

test('tag and shortcode query keeps exact ranking and copying with ranking preferences disabled too', async () => {
    for (const preferences of [true, false]) {
        const session = openPicker({ property: 'name', settings: {
            'picker.preferExactMatch': preferences, 'picker.preferPrefixMatch': preferences, 'picker.ignoreSpaces': false,
        }, dataset: [
            { name: 'smiley', emoji: '😃', description: 'grinning face', tags: ['happy'] },
            { name: 'smile', emoji: '😄', description: 'smiling face', tags: ['happy'] },
        ] });
        session.change('#happy smile');
        if (preferences) assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
        session.select('smile');
        await session.copySelection();
        assert.deepEqual(session.clipboardWrites, [':smile:']);
        await session.accept();
        assert.deepEqual(session.insertions, [':smile:']);
    }
});

for (const property of ['emoji', 'name']) {
    for (const via of ['button', 'command']) {
        test(`copy via ${via} uses active item and current ${property} mode without closing or inserting`, async () => {
            const historyState = createHistoryState(['cat']);
            const session = openPicker({ property, historyState, destination: 'terminal' });
            session.change('smile');
            session.select('smile_cat');
            // Single-select QuickPick uses activeItems for the highlighted row;
            // selectedItems need not track it until the user accepts.
            session.picker.selectedItems = [session.picker.items.find(item => item.emoji.name === 'cat')];
            const active = session.picker.activeItems[0];
            const order = session.names;
            const itemUpdates = session.itemUpdates;
            const copy = () => via === 'button' ? session.copySelection()
                : session.api.commands.executeCommand('emojisense.copyPickerSelection');
            assert.equal(active.buttons[0].iconPath.id, 'copy');
            assert.equal(session.picker.buttons.length, 3);
            await copy();
            assert.equal(active.buttons[0].iconPath.id, 'check');
            assert.equal(active.buttons[0].tooltip, property === 'emoji' ? 'Copied 😸' : 'Copied :smile_cat:');
            session.toggleInsertionMode();
            session.toggleDescriptions();
            await copy();
            assert.equal(active.buttons[0].tooltip, property === 'emoji' ? 'Copied :smile_cat:' : 'Copied 😸');
            assert.deepEqual(session.clipboardWrites,
                property === 'emoji' ? ['😸', ':smile_cat:'] : [':smile_cat:', '😸']);
            assert.equal(session.picker.activeItems[0], active);
            assert.equal(session.picker.value, 'smile');
            assert.deepEqual(session.names, order);
            assert.equal(session.itemUpdates, itemUpdates + 3); // Two copy confirmations and the description toggle.
            assert.deepEqual(session.insertions, []);
            assert.deepEqual(session.terminalWrites, []);
            assert.deepEqual(session.commands, []);
            assert.deepEqual(historyState.names, ['cat']);
            assert.equal(session.disposed, false);
            await session.cancel();
            assert.equal(session.copyFeedbackTimers.size, 0);
            assert.equal(session.commandHandlers.size, 0);
            assert.equal(session.activeSubscriptions, 0);
            assert.equal(session.contexts.get('emojisense.pickerOpen'), false);
        });
    }
}

test('copy with no active item leaves the clipboard untouched', async () => {
    const session = openPicker();
    session.picker.activeItems = [];
    await session.copySelection();
    await session.api.commands.executeCommand('emojisense.copyPickerSelection');
    assert.deepEqual(session.clipboardWrites, []);
    assert.equal(session.disposed, false);
    await session.cancel();
});

test('copy confirmation restores the icon after one second without changing query or focus', async () => {
    const session = openPicker();
    session.change('smile');
    session.select('smile_cat');
    const active = session.picker.activeItems[0];
    const order = session.names;
    await session.copySelection();
    assert.equal(active.buttons[0].iconPath.id, 'check');
    assert.equal([...session.copyFeedbackTimers.values()][0].delay, 1000);
    session.resetCopyFeedback();
    assert.equal(active.buttons[0].iconPath.id, 'copy');
    assert.equal(session.picker.activeItems[0], active);
    assert.deepEqual(session.names, order);
    assert.equal(session.picker.value, 'smile');
    assert.deepEqual(session.historyState.names, []);
    await session.cancel();
});

test('repeated copying renews confirmation and different rows reset independently', async () => {
    const session = openPicker();
    const first = session.picker.activeItems[0];
    await session.copySelection();
    const initialTimer = [...session.copyFeedbackTimers.keys()][0];
    await session.copySelection(); // Checkmark remains clickable.
    assert.equal(session.copyFeedbackTimers.size, 1);
    assert.equal(session.copyFeedbackTimers.has(initialTimer), false);
    session.select('cat');
    const second = session.picker.activeItems[0];
    await session.api.commands.executeCommand('emojisense.copyPickerSelection');
    assert.equal(first.buttons[0].iconPath.id, 'check');
    assert.equal(second.buttons[0].iconPath.id, 'check');
    assert.equal(session.copyFeedbackTimers.size, 2);
    session.resetCopyFeedback();
    assert.equal(first.buttons[0].iconPath.id, 'copy');
    assert.equal(second.buttons[0].iconPath.id, 'copy');
    assert.equal(session.picker.activeItems[0], second);
    await session.cancel();
});

test('a clipboard write completing after cancellation does not update the closed picker', async () => {
    const session = openPicker();
    let finishCopy;
    session.api.env.clipboard.writeText = () => new Promise(resolve => { finishCopy = resolve; });
    const copying = session.copySelection();
    await session.cancel();
    const updates = session.itemUpdates;
    finishCopy();
    await copying;
    assert.equal(session.copyFeedbackTimers.size, 0);
    assert.equal(session.itemUpdates, updates);
});

test('row copy copies the clicked item even when another item is highlighted', async () => {
    const session = openPicker({ property: 'name' });
    session.change('smile');
    const active = session.picker.activeItems[0];
    const hovered = session.picker.items.find(item => item.emoji.name === 'smile_cat');
    await session.copySelection(hovered);
    assert.deepEqual(session.clipboardWrites, [':smile_cat:']);
    assert.equal(session.picker.activeItems[0], active);
    assert.equal(session.disposed, false);
    assert.deepEqual(session.historyState.names, []);
    await session.cancel();
});

test('copy keeps the selected alias and does not interfere with subsequent editor insertion', async () => {
    const session = openPicker({ property: 'name' });
    session.select('thumbsup');
    await session.copySelection();
    assert.deepEqual(session.clipboardWrites, [':thumbsup:']);
    assert.deepEqual(session.historyState.names, []);
    await session.accept();
    assert.deepEqual(session.insertions, [':thumbsup:']);
    assert.deepEqual(session.historyState.names, ['thumbsup']);
});

test('a clipboard failure keeps the picker usable and allows another copy', async () => {
    const session = openPicker();
    const error = new Error('Clipboard unavailable');
    session.api.env.clipboard.writeText = async () => { throw error; };
    session.change('smile');
    await session.copySelection();
    assert.equal(session.warnings.length, 1);
    assert.equal(session.warnings[0][1], error);
    assert.deepEqual(session.messages, ['Could not copy emoji. Please try again.']);
    assert.equal(session.picker.activeItems[0].buttons[0].iconPath.id, 'copy');
    assert.equal(session.copyFeedbackTimers.size, 0);
    assert.equal(session.disposed, false);
    assert.deepEqual(session.historyState.names, []);
    session.api.env.clipboard.writeText = async text => { session.clipboardWrites.push(text); };
    await session.api.commands.executeCommand('emojisense.copyPickerSelection');
    assert.deepEqual(session.clipboardWrites, ['😄']);
    await session.accept();
    assert.deepEqual(session.insertions, ['😄']);
});

test('copy keybinding is restricted to the open emoji picker on all platforms', () => {
    const { contributes } = require('../package.json');
    const command = 'emojisense.copyPickerSelection';
    const binding = contributes.keybindings.find(binding => binding.command === command);
    assert.equal(binding.when, 'emojisense.pickerOpen && inQuickOpen');
    assert.equal(binding.mac, 'cmd+c');
    assert.equal(binding.key, 'ctrl+c');
    assert.equal(contributes.commands.find(entry => entry.command === command).enablement, 'emojisense.pickerOpen');
    assert.equal(contributes.menus.commandPalette.find(entry => entry.command === command).when, 'false');
});

for (const property of ['emoji', 'name']) {
    for (const destination of ['editor', 'terminal']) {
        for (const via of ['button', 'command']) {
            test(`switches ${property} insertion in ${destination} using ${via} without changing search or selection`, async () => {
                const session = openPicker({ property, destination });
                session.change('smile');
                session.select('smile_cat');
                const active = session.picker.activeItems[0];
                const order = session.names;
                const updates = session.itemUpdates;
                assert.equal(session.contexts.get('emojisense.pickerOpen'), true);
                assert.equal(session.picker.title, property === 'emoji' ? '😃 Emoji Picker' : ':smiley: Emoji Code Picker');
                assert.equal(session.picker.buttons[2].tooltip,
                    property === 'emoji' ? 'Insert :shortcode: instead (Tab)' : 'Insert emoji instead (Tab)');
                if (via === 'button') {
                    session.toggleInsertionMode();
                } else {
                    await session.api.commands.executeCommand('emojisense.togglePickerInsertionMode');
                }
                assert.equal(session.picker.title, property === 'emoji' ? ':smiley: Emoji Code Picker' : '😃 Emoji Picker');
                assert.equal(session.picker.buttons[2].tooltip,
                    property === 'emoji' ? 'Insert emoji instead (Tab)' : 'Insert :shortcode: instead (Tab)');
                assert.equal(session.picker.value, 'smile');
                assert.equal(session.picker.activeItems[0], active);
                assert.deepEqual(session.names, order);
                assert.equal(session.itemUpdates, updates);
                assert.equal(session.picker.matchOnDetail, false);
                assert.equal(session.disposed, false);
                assert.deepEqual(session.historyState.names, []);
                await session.accept();
                const expected = property === 'emoji' ? ':smile_cat:' : '😸';
                assert.deepEqual(session.insertions, destination === 'editor' ? [expected] : []);
                assert.deepEqual(session.terminalWrites,
                    destination === 'terminal' ? [{ text: expected, addNewLine: false }] : []);
                assert.deepEqual(session.historyState.names, ['smile_cat']);
                assert.equal(session.contexts.get('emojisense.pickerOpen'), false);
                assert.equal(session.commandHandlers.size, 0);
                assert.equal(session.activeSubscriptions, 0);
            });
        }
    }
}

test('mode switching works with input preferences disabled and cancellation resets the next opening', async () => {
    const settings = {
        'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false,
        'picker.ignoreSpaces': false, 'picker.description.search': false, 'picker.description.display': 'no',
    };
    const session = openPicker({ settings });
    session.change('cat face');
    session.toggleInsertionMode();
    assert.equal(session.picker.value, 'cat face');
    assert.equal(session.hasChangeHandler, true);
    assert.deepEqual(session.names, originalNames);
    await session.cancel();
    assert.deepEqual(session.insertions, []);
    assert.deepEqual(session.historyState.names, []);
    assert.equal(session.contexts.get('emojisense.pickerOpen'), false);
    assert.equal(session.commandHandlers.size, 0);
    const next = openPicker({ settings });
    assert.equal(next.picker.title, '😃 Emoji Picker');
    await next.cancel();
});

test('mode shortcut is restricted to the open emoji picker', () => {
    const { contributes } = require('../package.json');
    const command = 'emojisense.togglePickerInsertionMode';
    const binding = contributes.keybindings.find(binding => binding.command === command);
    assert.equal(binding.when, 'emojisense.pickerOpen && inQuickOpen');
    assert.equal(binding.mac, 'shift+cmd+i');
    assert.equal(binding.key, 'shift+ctrl+i');
    assert.equal(binding.linux, 'shift+ctrl+alt+i');
    assert.equal(contributes.commands.find(entry => entry.command === command).enablement, 'emojisense.pickerOpen');
});

for (const { exact, prefix, expected, focused } of combinations) {
    test(`independent preferences: exact=${exact}, prefix=${prefix}`, async t => {
        const session = openPicker({ settings: {
            'picker.preferExactMatch': exact, 'picker.preferPrefixMatch': prefix,
        } });
        t.after(() => session.cancel());
        session.change('smile');
        assert.deepEqual(session.names, expected);
        assert.equal(new Set(session.names).size, emojis.length);
        assert.equal(session.names.filter(name => name === 'smile').length, 1);
        if (focused) {
            assert.equal(session.picker.activeItems.length, 1);
            assert.equal(session.picker.activeItems[0].emoji.name, focused);
        } else {
            assert.equal(session.focusUpdates, 0);
        }
    });
}

test('both preferences default to enabled', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('smile');
    assert.deepEqual(session.names, combinations[3].expected);
});

test('description search defaults to enabled with shortcodes, descriptions, and tags on one line', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    assert.equal(session.picker.matchOnDetail, false);
    assert.equal(session.picker.matchOnDescription, true);
    const smile = session.picker.items.find(item => item.emoji.name === 'smile');
    assert.equal(smile.label, '😄');
    assert.equal(smile.detail, undefined);
    assert.equal(smile.tooltip, undefined);
    assert.equal(smile.description, ':smile: · grinning face with smiling eyes');
});

for (const property of ['emoji', 'name']) {
    test(`toggling descriptions preserves ${property} insertion and shared history`, async () => {
        const session = openPicker({ property });
        session.change('smile');
        session.toggleDescriptions();
        session.select('smile_cat');
        await session.accept();
        assert.deepEqual(session.insertions, [property === 'emoji' ? '😸' : ':smile_cat:']);
        assert.deepEqual(session.historyState.names, ['smile_cat']);
        assert.equal(session.activeSubscriptions, 0);
        assert.equal(session.disposed, true);
    });
}

test('description search works independently of exact and prefix preferences', async t => {
    const session = openPicker({ settings: {
        'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false,
        'picker.ignoreSpaces': false,
    } });
    t.after(() => session.cancel());
    assert.equal(session.picker.matchOnDetail, false);
    assert.equal(session.hasChangeHandler, true);
    assert.deepEqual(session.picker.items.map(item => item.description), emojis.map(emoji => `${emoji.name} · ${emoji.description}`));
});

test('description queries preserve whitespace when space ignoring is disabled', async t => {
    const session = openPicker({ settings: { 'picker.ignoreSpaces': false } });
    t.after(() => session.cancel());
    const query = 'grinning face with smiling eyes';
    session.change(query);
    assert.equal(session.picker.value, query);
    assert.deepEqual(session.names, originalNames);
    assert.equal(session.focusUpdates, 0);
});

for (const query of ['s mile', 'smi le', ' s m i l e ', ':s mile:']) {
    test(`ignores literal spaces in ${JSON.stringify(query)} without editing input and favors its exact shortcode`, async t => {
        const session = openPicker();
        t.after(() => session.cancel());
        session.change(query);
        assert.equal(session.picker.value, query);
        assert.deepEqual(session.names, combinations[3].expected);
        assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
        assert.equal(session.valueUpdates, 1, 'Typing must not rewrite the input');
    });
}

test('space ignoring works independently of match prioritization', async t => {
    const session = openPicker({ settings: {
        'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false,
    } });
    t.after(() => session.cancel());
    session.change('smile  cat');
    assert.equal(session.picker.value, 'smile  cat');
    assert.deepEqual(session.names, originalNames);
    assert.equal(session.picker.items.find(item => item.emoji.name === 'smile_cat').alwaysShow, true);
    assert.equal(session.picker.items.find(item => item.emoji.name === 'cat').alwaysShow, undefined);
});

test('space ignoring can be disabled without changing the input or forcing an exact match', async t => {
    const session = openPicker({ settings: { 'picker.ignoreSpaces': false } });
    t.after(() => session.cancel());
    session.change('s mile');
    assert.equal(session.picker.value, 's mile');
    assert.equal(session.valueUpdates, 1);
    assert.equal(session.focusUpdates, 0);
    assert(session.picker.items.every(item => !item.alwaysShow));
});

test('space fallback preserves compact fuzzy matches and resets when spaces disappear', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('smile cat');
    assert.equal(session.picker.value, 'smile cat');
    assert.equal(session.picker.items.find(item => item.emoji.name === 'smile_cat').alwaysShow, true);
    assert(session.picker.items.filter(item => item.alwaysShow).every(item => item.emoji.name === 'smile_cat'));
    session.change('smilecat');
    assert(session.picker.items.every(item => !item.alwaysShow));
    session.change('s _s');
    assert(session.picker.items.every(item => !item.alwaysShow)); // No arbitrary subsequence matching.
});

test('space fallback respects the description/tag search toggle and preserves input', async t => {
    const session = openPicker({ dataset: [{
        name: 'dog', emoji: '🐶', description: 'dog face', tags: ['pet'],
    }] });
    t.after(() => session.cancel());
    session.change('#p et');
    assert.equal(session.picker.value, '#p et');
    assert.equal(session.picker.items[0].alwaysShow, true);
    session.toggleSearch();
    assert.equal(session.picker.items[0].alwaysShow, false);
    session.toggleSearch();
    assert.equal(session.picker.items[0].alwaysShow, true);
    assert.equal(session.picker.value, '#p et');
});

for (const query of ['s\tmile', 's\u00a0mile']) {
    test(`space ignoring leaves other whitespace intact: ${JSON.stringify(query)}`, async t => {
        const session = openPicker();
        t.after(() => session.cancel());
        session.change(query);
        assert.equal(session.picker.value, query);
        assert.equal(session.valueUpdates, 1);
        assert.equal(session.focusUpdates, 0);
    });
}

test('space-only input stays visible without dropping items or updating history', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('   ');
    assert.equal(session.picker.value, '   ');
    assert.deepEqual(session.names, originalNames);
    assert.deepEqual(session.historyState.names, []);
});

test('description text and input stay readable when spaces are ignored', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('grinning face with smiling eyes');
    assert.equal(session.picker.value, 'grinning face with smiling eyes');
    assert.equal(session.picker.matchOnDetail, false);
    assert.equal(session.picker.items.find(item => item.emoji.name === 'smile').description, ':smile: · grinning face with smiling eyes');
});

for (const searchDescriptions of [true, false]) {
    for (const destination of ['editor', 'terminal']) {
        for (const property of ['emoji', 'name']) {
            test(`description search=${searchDescriptions} keeps ${property} insertion correct in ${destination}`, async () => {
                const session = openPicker({ property, destination, settings: { 'picker.description.search': searchDescriptions } });
                session.change(searchDescriptions ? 'grinning face with smiling eyes' : 'smile');
                session.select('smile');
                await session.accept();
                const text = property === 'emoji' ? '😄' : ':smile:';
                assert.deepEqual(session.insertions, destination === 'editor' ? [text] : []);
                assert.deepEqual(session.terminalWrites, destination === 'terminal' ? [{ text, addNewLine: false }] : []);
                assert.deepEqual(session.historyState.names, ['smile']);
            });
        }
    }
}

for (const query of ['smile', ':smile:', ':smile', 'smile:', 'SMILE', '  :SMILE:  ']) {
    test(`normalizes ${JSON.stringify(query)} without dropping other candidates`, async t => {
        const session = openPicker();
        t.after(() => session.cancel());
        session.change(query);
        assert.deepEqual(session.names, combinations[3].expected);
        assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
    });
}

test('partial input favors prefixes and preserves fuzzy candidates in their original order', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('smi');
    assert.deepEqual(session.names, combinations[2].expected);
    assert.equal(session.picker.activeItems[0].emoji.name, 'smile_cat');
});

test('exact-only mode does not promote prefixes', async t => {
    const session = openPicker({ settings: { 'picker.preferPrefixMatch': false } });
    t.after(() => session.cancel());
    session.change('smi');
    assert.deepEqual(session.names, originalNames);
    assert.equal(session.focusUpdates, 0);
});

test('all input preferences off preserves original presentation, list identity, and native focus', async t => {
    const session = openPicker({ settings: {
        'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false,
        'picker.ignoreSpaces': false, 'picker.description.search': false, 'picker.description.display': 'no',
    } });
    t.after(() => session.cancel());
    const initialItems = session.picker.items;
    assert.equal(session.hasChangeHandler, true);
    assert.deepEqual(initialItems.map(({ label, description }) => ({ label, description })),
        emojis.map(emoji => ({ label: emoji.emoji, description: emoji.name })));
    for (const query of ['smile', ':smile:', 'smi', '', 'missing']) session.change(query);
    assert.equal(session.picker.items, initialItems);
    assert.equal(session.itemUpdates, 1);
    assert.equal(session.focusUpdates, 0);
});

test('clearing or replacing an exact query restores original order', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    for (const query of ['', ':', 'missing', 'sml']) {
        session.change('smile');
        session.change(query);
        assert.deepEqual(session.names, originalNames);
    }
});

test('user can accept a different fuzzy result after exact-match focus', async () => {
    const session = openPicker();
    session.change('smile');
    session.select('sweat_smile');
    await session.accept();
    assert.deepEqual(session.insertions, ['😅']);
    assert.equal(session.disposed, true);
    assert.equal(session.activeSubscriptions, 0);
});

for (const destination of ['editor', 'terminal']) {
    for (const property of ['emoji', 'name']) {
        test(`inserts ${property} in ${destination} when hide fires synchronously on acceptance`, async () => {
            const session = openPicker({ property, destination });
            session.change(':smile:');
            await session.accept();
            const text = property === 'emoji' ? '😄' : ':smile:';
            assert.deepEqual(session.insertions, destination === 'editor' ? [text] : []);
            assert.deepEqual(session.terminalWrites, destination === 'terminal' ? [{ text, addNewLine: false }] : []);
            assert.deepEqual(session.commands, destination === 'terminal' ? ['workbench.action.terminal.focus'] : []);
            assert.equal(session.disposed, true);
            assert.equal(session.activeSubscriptions, 0);
        });
    }
}

for (const query of [':+1:', 'thumbsup']) {
    test(`keeps the selected shortcode for alias ${query}`, async () => {
        const session = openPicker({ property: 'name' });
        session.change(query);
        await session.accept();
        assert.deepEqual(session.insertions, [query === 'thumbsup' ? ':thumbsup:' : ':+1:']);
        assert.deepEqual(session.historyState.names, [query === 'thumbsup' ? 'thumbsup' : '+1']);
    });
}

test('cancelling inserts nothing', async () => {
    const session = openPicker();
    session.change('smile');
    await session.cancel();
    assert.deepEqual(session.insertions, []);
    assert.deepEqual(session.terminalWrites, []);
    assert.deepEqual(session.historyState.names, []);
    assert.equal(session.disposed, true);
    assert.equal(session.activeSubscriptions, 0);
});

test('closing the editor or terminal while picking does not throw or insert', async () => {
    for (const destination of ['editor', 'terminal']) {
        const session = openPicker({ destination });
        session.change('smile');
        session.api.window.activeTextEditor = undefined;
        session.api.window.activeTerminal = undefined;
        await session.accept();
        assert.deepEqual(session.insertions, []);
        assert.deepEqual(session.terminalWrites, []);
        assert.deepEqual(session.historyState.names, []);
    }
});

test('Unicode and shortcode pickers share persistent most-recent-first history across destinations', async t => {
    const historyState = createHistoryState();
    const unicode = openPicker({ historyState });
    unicode.select('cat');
    await unicode.accept();
    assert.deepEqual(historyState.names, ['cat']);

    // Each opening creates a fresh factory, also checking restoration from storage.
    const shortcode = openPicker({ historyState, property: 'name', destination: 'terminal' });
    assert.equal(shortcode.names[0], 'cat');
    shortcode.select('smile');
    await shortcode.accept();
    assert.deepEqual(historyState.names, ['smile', 'cat']);

    const reopened = openPicker({ historyState });
    t.after(() => reopened.cancel());
    assert.deepEqual(reopened.names.slice(0, 2), ['smile', 'cat']);
    assert.deepEqual([...reopened.names].sort(), [...originalNames].sort());
});

test('reusing an emoji moves its one history entry to the front', async () => {
    const historyState = createHistoryState(['smile', 'cat']);
    const session = openPicker({ historyState, property: 'name' });
    session.select('cat');
    await session.accept();
    assert.deepEqual(historyState.names, ['cat', 'smile']);
});

test('match preferences take priority over history and clearing input restores recents', async t => {
    const historyState = createHistoryState(['cat', 'sweat_smile', 'smile']);
    const session = openPicker({ historyState });
    t.after(() => session.cancel());
    session.change('smile');
    assert.deepEqual(session.names.slice(0, 4), ['smile', 'smile_cat', 'smiley', 'cat']);
    session.change('smi');
    assert.deepEqual(session.names.slice(0, 3), ['smile', 'smile_cat', 'smiley']);
    session.change('');
    assert.deepEqual(session.names.slice(0, 3), ['cat', 'sweat_smile', 'smile']);
});

test('history remains shared when both match preferences are disabled', async t => {
    const session = openPicker({ historyState: createHistoryState(['cat']), settings: {
        'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false,
        'picker.ignoreSpaces': false,
    } });
    t.after(() => session.cancel());
    assert.equal(session.names[0], 'cat');
    assert.equal(session.hasChangeHandler, true);
    assert.equal(session.picker.items[0].label, '🐱');
    assert.equal(session.picker.items[0].description, 'cat · cat face');
});

test('history is bounded, ignores removed shortcodes, and does not duplicate candidates', async () => {
    const dataset = Array.from({ length: 205 }, (_, i) => ({ name: `emoji_${i}`, emoji: '😄', description: `Emoji ${i}` }));
    const historyState = createHistoryState(['removed', 'emoji_0', 'emoji_0', ...dataset.map(item => item.name)]);
    const session = openPicker({ dataset, historyState });
    assert.equal(session.names.length, dataset.length);
    assert.equal(new Set(session.names).size, dataset.length);
    session.select('emoji_204');
    await session.accept();
    assert.deepEqual(historyState.names, ['emoji_204', ...dataset.slice(0, 199).map(item => item.name)]);
});

test('only changed rankings replace the picker list', async t => {
    const session = openPicker();
    t.after(() => session.cancel());
    session.change('s');
    assert.equal(session.itemUpdates, 1);
    session.change('sm');
    const prefixes = session.picker.items;
    assert.equal(session.itemUpdates, 2);
    for (const query of ['smi', 'smil']) {
        session.change(query);
        assert.equal(session.picker.items, prefixes);
        assert.equal(session.itemUpdates, 2);
    }
    session.change('smile');
    assert.equal(session.itemUpdates, 3);
    const exact = session.picker.items;
    session.change(':SMILE:');
    assert.equal(session.picker.items, exact);
    assert.equal(session.itemUpdates, 3);
    session.change('');
    assert.equal(session.itemUpdates, 4);
    const original = session.picker.items;
    for (const query of [':', 'missing', 'sml']) {
        session.change(query);
        assert.equal(session.picker.items, original);
        assert.equal(session.itemUpdates, 4);
    }
    assert.deepEqual(session.names, originalNames);
});

for (const destination of ['editor', 'terminal']) {
    for (const synchronous of [false, true]) {
        test(`${destination} insertion succeeds when history saving ${synchronous ? 'throws' : 'rejects'}`, async () => {
            const historyState = createHistoryState(['cat']);
            const error = new Error('History storage unavailable');
            historyState.update = synchronous
                ? () => { throw error; }
                : async () => { throw error; };
            const session = openPicker({ historyState, destination });
            session.change('smile');
            await session.accept();
            assert.deepEqual(session.insertions, destination === 'editor' ? ['😄'] : []);
            assert.deepEqual(session.terminalWrites, destination === 'terminal' ? [{ text: '😄', addNewLine: false }] : []);
            assert.deepEqual(session.commands, destination === 'terminal' ? ['workbench.action.terminal.focus'] : []);
            assert.deepEqual(historyState.names, ['cat']);
            assert.equal(session.warnings.length, 1);
            assert.equal(session.warnings[0][1], error);
            assert.equal(session.activeSubscriptions, 0);
            assert.equal(session.disposed, true);
        });
    }
}

test('picker and event subscriptions are disposed if showing the picker fails', async () => {
    const error = new Error('Cannot show picker');
    const session = openPicker({ showError: error });
    await assert.rejects(session.done, error);
    assert.equal(session.activeSubscriptions, 0);
    assert.equal(session.disposed, true);
    assert.equal(session.contexts.get('emojisense.pickerOpen'), false);
    assert.equal(session.commandHandlers.size, 0);
    assert.deepEqual(session.insertions, []);
    assert.deepEqual(session.historyState.names, []);
});

test('failed editor edits and cancellation do not change existing history', async () => {
    const historyState = createHistoryState(['cat']);
    const failed = openPicker({ historyState });
    failed.api.window.activeTextEditor.edit = async () => false;
    failed.select('smile');
    await failed.accept();
    assert.deepEqual(historyState.names, ['cat']);

    const cancelled = openPicker({ historyState });
    cancelled.select('smile');
    await cancelled.cancel();
    assert.deepEqual(historyState.names, ['cat']);
});

test('all real emoji aliases remain unique and available across ranking transitions', async t => {
    const { gemoji } = await import('gemoji');
    const byName = new Map();
    for (const record of gemoji) {
        for (const name of record.names) {
            if (!byName.has(name)) byName.set(name, { name, emoji: record.emoji, description: record.description });
        }
    }
    const dataset = [...byName.values()];
    const allNames = [...byName.keys()].sort();
    for (const { exact, prefix } of combinations) {
        const session = openPicker({ dataset, settings: {
            'picker.preferExactMatch': exact, 'picker.preferPrefixMatch': prefix,
        } });
        t.after(() => session.cancel());
        for (const query of ['s', 'smi', 'smile', ':smile:', 'cat', ':+1:', 'heart', 'missing', '']) {
            session.change(query);
            assert.deepEqual([...session.names].sort(), allNames);
            assert.equal(new Set(session.names).size, dataset.length);
        }
    }
});

// Model the native filtering boundary as well as extension-supplied matches.
// This does not model native sorting. Rendering and real key dispatch are checked in the host.
function visibleNames(session) {
    return session.picker.items.filter(item => item.alwaysShow || [
        item.label,
        session.picker.matchOnDescription ? item.description : '',
        session.picker.matchOnDetail ? item.detail : '',
    ].some(field => matching.matchesPickerQuery(session.picker.value, field || ''))).map(item => item.emoji.name);
}

const descriptionDataset = [
    { name: 'cat', emoji: '🐱', description: 'cat face', tags: ['pet'] },
    { name: 'smiley', emoji: '😃', description: 'grinning face with big eyes', tags: ['happy', 'joy'] },
    { name: 'smile', emoji: '😄', description: 'grinning face with smiling eyes', tags: ['happy'] },
];

for (const property of ['emoji', 'name']) {
    for (const display of ['no', 'description', 'detail']) {
        for (const search of [false, true]) {
            test(`${property}: display=${display}, search=${search} keep rendering and matching independent`, async t => {
                const session = openPicker({ property, dataset: descriptionDataset, settings: {
                    'picker.description.display': display, 'picker.description.search': search,
                } });
                t.after(() => session.cancel());
                const item = session.picker.items.find(item => item.emoji.name === 'smiley');
                assert.equal(item.description, display === 'description'
                    ? ':smiley: · grinning face with big eyes · #happy #joy' : ':smiley:');
                assert.equal(item.detail, display === 'detail' ? 'grinning face with big eyes · #happy #joy' : undefined);
                for (const query of ['grinning', '#happy', '#happy face', 'face #happy', '#joy #happy']) {
                    session.change(query);
                    const expected = query.includes('#joy') ? ['smiley'] : ['smiley', 'smile'];
                    assert.deepEqual(visibleNames(session), search ? expected : [], query);
                    assert.equal(session.picker.value, query);
                }
                session.change(':smiley:');
                assert.deepEqual(visibleNames(session), ['smiley']);
                assert.equal(session.picker.activeItems[0].emoji.name, 'smiley');
                session.change('s mile');
                assert.deepEqual(visibleNames(session), ['smile', 'smiley']);
                assert.equal(session.picker.value, 's mile');
                session.change('🐱');
                assert.deepEqual(visibleNames(session), ['cat']);
                session.change('');
                assert.deepEqual(visibleNames(session), ['cat', 'smiley', 'smile']);
            });
        }
    }
    for (const via of ['button', 'command']) {
        test(`${property}: ${via} cycles display independently and preserves query, selection, copy and history`, async () => {
            const session = openPicker({ property, dataset: descriptionDataset });
            session.change('smil');
            session.select('smiley');
            const active = session.picker.activeItems[0];
            const cycle = () => via === 'button' ? session.toggleDescriptions()
                : session.api.commands.executeCommand('emojisense.cyclePickerDescriptionDisplay');
            for (const display of ['detail', 'no', 'description', 'detail']) {
                await cycle();
                assert.equal(session.picker.value, 'smil');
                assert.equal(session.picker.activeItems[0], active);
                assert.equal(active.description, display === 'description'
                    ? ':smiley: · grinning face with big eyes · #happy #joy' : ':smiley:');
                assert.equal(active.detail, display === 'detail' ? 'grinning face with big eyes · #happy #joy' : undefined);
                assert.equal(session.picker.buttons[0].iconPath.id, 'list-selection');
                assert(session.picker.buttons[0].tooltip.includes(`Description display: ${display}.`));
                assert(session.picker.buttons[1].tooltip.includes('search: on'));
                assert.deepEqual(session.historyState.names, []);
            }
            await session.copySelection();
            const expected = property === 'emoji' ? '😃' : ':smiley:';
            assert.deepEqual(session.clipboardWrites, [expected]);
            await session.accept();
            assert.deepEqual(session.insertions, [expected]);
            assert.deepEqual(session.historyState.names, ['smiley']);
            assert.equal(session.commandHandlers.size, 0);
            assert.equal(session.activeSubscriptions, 0);
        });
    }
}

for (const display of ['no', 'description', 'detail']) {
    for (const via of ['button', 'command']) {
        test(`${via} toggles search without changing ${display} display and recomputes tag queries`, async t => {
            const session = openPicker({ dataset: descriptionDataset, settings: { 'picker.description.display': display } });
            t.after(() => session.cancel());
            const initial = session.picker.items.map(item => [item.description, item.detail]);
            session.change('#happy smile');
            assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
            const toggle = () => via === 'button' ? session.toggleSearch()
                : session.api.commands.executeCommand('emojisense.togglePickerDescriptionSearch');
            await toggle();
            assert.deepEqual(visibleNames(session), []);
            assert(session.picker.buttons[1].tooltip.includes('search: off'));
            assert.equal(session.picker.buttons[1].iconPath.id, 'book');
            await toggle();
            assert.deepEqual(visibleNames(session), ['smile', 'smiley']);
            assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
            assert.deepEqual(session.picker.items.slice().sort((a, b) => descriptionDataset.findIndex(e => e.name === a.emoji.name) - descriptionDataset.findIndex(e => e.name === b.emoji.name)).map(item => [item.description, item.detail]), initial);
            assert.equal(session.picker.value, '#happy smile');
        });
    }
}

test('both description controls are session-local, with no legacy fallback', async t => {
    const settings = { 'picker.searchDescriptions': false };
    const first = openPicker({ settings });
    first.toggleDescriptions();
    first.toggleSearch();
    await first.cancel();
    const next = openPicker({ settings });
    t.after(() => next.cancel());
    assert.equal(next.picker.items[0].description, ':sweat_smile: · grinning face with sweat');
    assert.equal(next.picker.items[0].detail, undefined);
    assert(next.picker.buttons[1].tooltip.includes('search: on'));
    assert.deepEqual(settings, { 'picker.searchDescriptions': false });
});

test('description commands have input-scoped shortcuts and independent settings', () => {
    const { contributes } = require('../package.json');
    for (const [command, key, mac] of [
        ['emojisense.cyclePickerDescriptionDisplay', 'shift+tab', undefined],
        ['emojisense.togglePickerDescriptionSearch', 'ctrl+shift+d', 'cmd+shift+d'],
    ]) {
        const binding = contributes.keybindings.find(binding => binding.command === command);
        assert.equal(binding.key, key);
        assert.equal(binding.mac, mac);
        assert.equal(binding.when, "emojisense.pickerOpen && inQuickInput && quickInputType == 'quickPick' && inputFocus");
        assert.equal(contributes.commands.find(entry => entry.command === command).enablement, 'emojisense.pickerOpen');
    }
    const properties = contributes.configuration.properties;
    assert.equal(properties['emojisense.picker.searchDescriptions'], undefined);
    assert.equal(properties['emojisense.picker.description.search'].default, true);
    assert.equal(properties['emojisense.picker.description.display'].default, 'description');
    assert.deepEqual(properties['emojisense.picker.description.display'].enum, ['no', 'description', 'detail']);
});

for (const display of ['no', 'description', 'detail']) {
    test(`${display}: independent search still works with ranking and space ignoring disabled`, async t => {
        const session = openPicker({ dataset: descriptionDataset, settings: {
            'picker.description.display': display, 'picker.description.search': false,
            'picker.preferExactMatch': false, 'picker.preferPrefixMatch': false, 'picker.ignoreSpaces': false,
        } });
        t.after(() => session.cancel());
        session.change('grinning face');
        assert.deepEqual(visibleNames(session), []);
        session.toggleSearch();
        assert.deepEqual(visibleNames(session), ['smiley', 'smile']);
        for (const query of ['#happy face', 'face #happy']) {
            session.change(query);
            assert.deepEqual(visibleNames(session), ['smiley', 'smile']);
        }
        session.change('s mile');
        assert.deepEqual(visibleNames(session), []);
        session.change('smile');
        assert.deepEqual(visibleNames(session), ['smiley', 'smile']);
        assert.equal(session.picker.value, 'smile');
    });
}

for (const vscodeVersion of ['1.80.2', '1.81.0', '1.145.0', '2.0.0']) {
    test(`SVG icons respect the stable API boundary on VS Code ${vscodeVersion}`, async t => {
        const session = openPicker({ vscodeVersion });
        t.after(() => session.cancel());
        const item = session.picker.items[0];
        if (vscodeVersion === '1.80.2') {
            assert.equal(item.iconPath, undefined);
            assert.equal(item.label, '😅');
            assert.equal(item.description, ':sweat_smile: · grinning face with sweat');
        } else {
            assert(item.iconPath.toString().startsWith('data:image/svg+xml,'));
            assert.equal(item.label, ':sweat_smile:');
            assert.equal(item.description, '· grinning face with sweat');
        }
    });
}

for (const display of ['no', 'description', 'detail']) {
    for (const search of [false, true]) {
        test(`SVG layout display=${display}, search=${search} preserves matching and exact focus`, async t => {
            const session = openPicker({ vscodeVersion: '1.145.0', dataset: descriptionDataset, settings: {
                'picker.description.display': display, 'picker.description.search': search,
            } });
            t.after(() => session.cancel());
            const item = session.picker.items.find(item => item.emoji.name === 'smiley');
            assert.equal(item.label, ':smiley:');
            assert.equal(item.description, display === 'description' ? '· grinning face with big eyes · #happy #joy' : undefined);
            assert.equal(item.detail, display === 'detail' ? 'grinning face with big eyes · #happy #joy' : undefined);
            assert(item.iconPath);
            for (const query of ['grinning', '#happy', '#happy face', 'face #happy']) {
                session.change(query);
                assert.deepEqual(visibleNames(session), search ? ['smiley', 'smile'] : [], query);
            }
            for (const query of ['smile', ':smile:', 's mile']) {
                session.change(query);
                assert.equal(session.picker.activeItems[0].emoji.name, 'smile');
                assert.equal(session.names.filter(name => name === 'smile').length, 1);
                assert(visibleNames(session).includes('smile'));
                if (query !== ':smile:') assert(visibleNames(session).includes('smiley'));
            }
            session.change('😃');
            assert.deepEqual(visibleNames(session), ['smiley']);
            assert.equal(session.picker.value, '😃');
        });
    }
}

for (const property of ['emoji', 'name']) {
    for (const destination of ['editor', 'terminal']) {
        test(`SVG layout preserves ${property} copy/insertion in ${destination} and both controls`, async () => {
            const session = openPicker({ property, destination, vscodeVersion: '1.145.0' });
            session.change('smile');
            session.select('smile_cat');
            const active = session.picker.activeItems[0];
            const icon = active.iconPath;
            for (let i = 0; i < 3; i++) session.toggleDescriptions();
            session.toggleSearch();
            assert.equal(active.iconPath, icon);
            assert.equal(session.picker.activeItems[0], active);
            assert.equal(session.picker.value, 'smile');
            await session.copySelection();
            const expected = property === 'emoji' ? '😸' : ':smile_cat:';
            assert.deepEqual(session.clipboardWrites, [expected]);
            await session.accept();
            assert.deepEqual(session.insertions, destination === 'editor' ? [expected] : []);
            assert.deepEqual(session.terminalWrites, destination === 'terminal' ? [{ text: expected, addNewLine: false }] : []);
            assert.deepEqual(session.historyState.names, ['smile_cat']);
        });
    }
}

test('SVG aliases share an icon and pasted keycaps remain searchable', async t => {
    const session = openPicker({ vscodeVersion: '1.145.0', dataset: [
        { name: '+1', emoji: '👍', description: 'thumbs up' },
        { name: 'thumbsup', emoji: '👍', description: 'thumbs up' },
        { name: 'one', emoji: '1️⃣', description: 'keycap one' },
    ] });
    t.after(() => session.cancel());
    assert.equal(session.picker.items[0].iconPath, session.picker.items[1].iconPath);
    session.change('👍');
    assert.deepEqual(visibleNames(session), ['+1', 'thumbsup']);
    session.change('1️⃣');
    assert.deepEqual(visibleNames(session), ['one']);
    session.change('1');
    assert(visibleNames(session).includes('one'));
});

test('Tab switches insertion mode only from the picker search input', () => {
    const { contributes } = require('../package.json');
    const binding = contributes.keybindings.find(binding => binding.key === 'tab');
    assert.equal(binding.command, 'emojisense.togglePickerInsertionMode');
    assert.equal(binding.when, "emojisense.pickerOpen && inQuickInput && quickInputType == 'quickPick' && inputFocus");
    assert.equal(contributes.keybindings.filter(binding => binding.key === 'tab').length, 1);
});

for (const vscodeVersion of ['1.75.0', '1.145.0']) {
    test(`picker-mode command retains query, selection and SVG layout on ${vscodeVersion}`, async () => {
        const session = openPicker({ vscodeVersion });
        session.change('smile');
        session.select('smile_cat');
        const active = session.picker.activeItems[0];
        const { label, iconPath, description, detail } = active;
        await session.api.commands.executeCommand('emojisense.togglePickerInsertionMode');
        assert.equal(session.picker.value, 'smile');
        assert.equal(session.picker.activeItems[0], active);
        assert.deepEqual({ label: active.label, iconPath: active.iconPath, description: active.description, detail: active.detail }, { label, iconPath, description, detail });
        assert.equal(session.picker.title, ':smiley: Emoji Code Picker');
        assert.equal(session.picker.buttons[2].tooltip, 'Insert emoji instead (Tab)');
        assert(session.picker.buttons[0].tooltip.includes('Shift+Tab'));
        assert(session.picker.buttons[1].tooltip.includes('Cmd/Ctrl+Shift+D'));
        await session.copySelection();
        assert.deepEqual(session.clipboardWrites, [':smile_cat:']);
        await session.accept();
        assert.deepEqual(session.insertions, [':smile_cat:']);
    });
}
