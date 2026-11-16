import { commands, Disposable, env, Memento, QuickPickItem, ThemeIcon, window, workspace } from 'vscode';
import { Emoji, EmojiProvider } from './emoji';
import { matchesPickerQuery } from './pickerMatching';

export type EmojiDestination = 'terminal' | 'editor';
type DescriptionDisplay = 'no' | 'description' | 'detail';

interface EmojiQuickPickItem extends QuickPickItem {
    readonly emoji: Emoji;
}

const historyKey = 'picker.history';
const historyLimit = 200;

const descriptionFor = (emoji: Emoji) => emoji.tags.length
    ? `${emoji.description} · ${emoji.tags.map(tag => `#${tag}`).join(' ')}`
    : emoji.description;

export const quickEmoji = (provider: EmojiProvider, historyState: Memento) => {
    const items: EmojiQuickPickItem[] = provider.emojis.map((emoji) => {
        return ({ description: emoji.name, label: emoji.emoji, emoji });
    });
    const itemsByName = new Map(items.map(item => [item.emoji.name, item]));

    const recentItems = () => Array.from(new Set(historyState.get<readonly string[]>(historyKey, [])))
        .map(name => itemsByName.get(name))
        .filter((item): item is EmojiQuickPickItem => !!item)
        .slice(0, historyLimit);

    const remember = async (name: string) => {
        try {
            const names = [name, ...recentItems()
                .filter(recent => recent.emoji.name !== name)
                .map(recent => recent.emoji.name)].slice(0, historyLimit);
            await historyState.update(historyKey, names);
        } catch (error) {
            console.warn('Emojisense: Could not save picker history.', error);
        }
    };

    return (property: keyof Emoji, destination: EmojiDestination) => {
        return async () => {
            let insertionProperty = property;
            const textFor = (item: EmojiQuickPickItem) => insertionProperty === 'name'
                ? `:${item.emoji.name}:` : item.emoji.emoji;
            const config = workspace.getConfiguration('emojisense', window.activeTextEditor?.document.uri);
            const preferExactMatch = config.get<boolean>('picker.preferExactMatch', true);
            const preferPrefixMatch = config.get<boolean>('picker.preferPrefixMatch', true);
            let searchDescriptions = config.get<boolean>('picker.description.search', true);
            let descriptionDisplay = config.get<DescriptionDisplay>('picker.description.display', 'description');
            const ignoreSpaces = config.get<boolean>('picker.ignoreSpaces', true);
            const shortcodeFor = (emoji: Emoji) => preferExactMatch || preferPrefixMatch ? `:${emoji.name}:` : emoji.name;
            const itemDescriptionFor = (emoji: Emoji) => descriptionDisplay === 'description'
                ? `${shortcodeFor(emoji)} · ${descriptionFor(emoji)}` : shortcodeFor(emoji);
            const recent = new Set(recentItems());
            const orderedItems = recent.size
                ? [...recent, ...items.filter(item => !recent.has(item))]
                : items;

            const picker = window.createQuickPick<EmojiQuickPickItem>();
            const disposables: Disposable[] = [];
            let selectedItem: EmojiQuickPickItem | undefined;
            try {
                selectedItem = await new Promise<EmojiQuickPickItem | undefined>((resolve) => {
                    const copy = { iconPath: new ThemeIcon('copy'), tooltip: 'Copy in current insertion mode' };
                    const rankedItems: EmojiQuickPickItem[] = orderedItems.map(item => ({
                        ...item,
                        description: itemDescriptionFor(item.emoji),
                        detail: descriptionDisplay === 'detail' ? descriptionFor(item.emoji) : undefined,
                        buttons: [copy],
                    }));
                    picker.items = rankedItems;
                    let displayedItems = rankedItems;
                    let copyFeedbackDisposed = false;
                    const copyFeedbackTimers = new Map<EmojiQuickPickItem, ReturnType<typeof setTimeout>>();
                    disposables.push({ dispose: () => {
                        copyFeedbackDisposed = true;
                        copyFeedbackTimers.forEach(timer => clearTimeout(timer));
                        copyFeedbackTimers.clear();
                    } });
                    const refreshItems = () => {
                        const activeItems = picker.activeItems;
                        picker.items = displayedItems;
                        picker.activeItems = activeItems;
                    };
                    const queryParts = (value: string) => {
                        const terms = value.split(/ +/).filter(Boolean);
                        const tags = searchDescriptions ? terms.filter(term => term.startsWith('#') && term.length > 1) : [];
                        const text = tags.length ? terms.filter(term => !tags.includes(term)).join(' ') : value;
                        return { tags, text: ignoreSpaces ? text.replace(/ /g, '') : text };
                    };
                    const matchesTags = (item: EmojiQuickPickItem, tags: readonly string[]) => tags.every(tag =>
                        item.emoji.tags.some(candidate => matchesPickerQuery(tag, `#${candidate}`)));
                    const updateExtraMatches = () => {
                        const value = picker.value;
                        const normalized = value.replace(/ /g, '');
                        const needsFallback = ignoreSpaces && normalized !== value;
                        const { tags, text: query } = queryParts(value);
                        const combined = tags.length > 0 && (query.trim().length > 0 || tags.length > 1);
                        // Native filtering only sees displayed fields. Supply semantic matches
                        // when searchable text is hidden or shares a field with excluded text.
                        const customSearch = descriptionDisplay === 'no' && searchDescriptions
                            || descriptionDisplay === 'description' && !searchDescriptions;
                        let changed = false;
                        for (const item of rankedItems) {
                            const fields = [item.emoji.emoji, shortcodeFor(item.emoji),
                                searchDescriptions ? descriptionFor(item.emoji) : ''];
                            const alwaysShow = combined || customSearch && tags.length > 0
                                ? matchesTags(item, tags)
                                    && fields.some(text => matchesPickerQuery(query, text))
                                : (needsFallback || customSearch) && fields.some(text => matchesPickerQuery(query, text));
                            if (!!item.alwaysShow !== alwaysShow) {
                                item.alwaysShow = alwaysShow;
                                changed = true;
                            }
                        }
                        return changed;
                    };
                    picker.placeholder = 'Your Emoji Code';
                    const cycleDescriptionDisplay = { iconPath: new ThemeIcon('list-selection'), tooltip: '' };
                    const toggleDescriptionSearch = { iconPath: new ThemeIcon('book'), tooltip: '' };
                    const useShortcode = { iconPath: new ThemeIcon('symbol-key'), tooltip: 'Insert :shortcode: instead' };
                    const useEmoji = { iconPath: new ThemeIcon('smiley'), tooltip: 'Insert emoji instead' };
                    const updateControls = () => {
                        picker.matchOnDescription = descriptionDisplay !== 'description' || searchDescriptions;
                        picker.matchOnDetail = descriptionDisplay === 'detail' && searchDescriptions;
                        const nextDisplay = descriptionDisplay === 'no' ? 'description' : descriptionDisplay === 'description' ? 'detail' : 'no';
                        cycleDescriptionDisplay.tooltip = `Description display: ${descriptionDisplay}. Switch to ${nextDisplay} (Shift+Tab)`;
                        toggleDescriptionSearch.tooltip = `Description and tag search: ${searchDescriptions ? 'on' : 'off'}. Click to ${searchDescriptions ? 'disable' : 'enable'}`;
                        picker.title = insertionProperty === 'emoji' ? '😃 Emoji Picker' : ':smiley: Emoji Code Picker';
                        picker.buttons = [
                            cycleDescriptionDisplay,
                            toggleDescriptionSearch,
                            insertionProperty === 'emoji' ? useShortcode : useEmoji,
                        ];
                    };
                    const toggleInsertionMode = () => {
                        insertionProperty = insertionProperty === 'emoji' ? 'name' : 'emoji';
                        updateControls();
                    };
                    updateControls();
                    const copyItem = async (item: EmojiQuickPickItem | undefined) => {
                        if (!item) {
                            return;
                        }
                        try {
                            const text = textFor(item);
                            await env.clipboard.writeText(text);
                            if (copyFeedbackDisposed) {
                                return;
                            }
                            clearTimeout(copyFeedbackTimers.get(item));
                            item.buttons = [{ iconPath: new ThemeIcon('check'), tooltip: `Copied ${text}` }];
                            refreshItems();
                            copyFeedbackTimers.set(item, setTimeout(() => {
                                copyFeedbackTimers.delete(item);
                                item.buttons = [copy];
                                refreshItems();
                            }, 1000));
                        } catch (error) {
                            console.warn('Emojisense: Could not copy picker selection.', error);
                            if (!copyFeedbackDisposed) {
                                void window.showWarningMessage('Could not copy emoji. Please try again.');
                            }
                        }
                    };
                    const copySelection = () => copyItem(picker.activeItems[0]);
                    disposables.push(commands.registerCommand('emojisense.togglePickerInsertionMode', toggleInsertionMode));
                    disposables.push(commands.registerCommand('emojisense.copyPickerSelection', copySelection));
                    disposables.push(picker.onDidTriggerItemButton(event => {
                        if (event.button === event.item.buttons?.[0]) {
                            return copyItem(event.item);
                        }
                    }));
                    disposables.push(picker.onDidTriggerButton(button => {
                        if (button === useShortcode || button === useEmoji) {
                            toggleInsertionMode();
                            return;
                        }
                        if (button === cycleDescriptionDisplay) {
                            cycleDisplay();
                        } else if (button === toggleDescriptionSearch) {
                            toggleSearch();
                        }
                    }));
                    const updateResults = (value: string) => {
                        const { tags, text: query } = queryParts(value);
                        const extraMatchesChanged = updateExtraMatches();
                        if (!preferExactMatch && !preferPrefixMatch) {
                            if (extraMatchesChanged) {
                                refreshItems();
                            }
                            return;
                        }
                        const name = query.trim().replace(/^:|:$/g, '').toLowerCase();
                        let exactMatch: EmojiQuickPickItem | undefined;
                        const prefixMatches: EmojiQuickPickItem[] = [];
                        const otherItems: EmojiQuickPickItem[] = [];

                        for (const item of rankedItems) {
                            const itemName = item.emoji.name.toLowerCase();
                            const eligible = matchesTags(item, tags);
                            if (eligible && name && preferExactMatch && itemName === name) {
                                exactMatch = item;
                            } else if (eligible && name && preferPrefixMatch && itemName.startsWith(name)) {
                                prefixMatches.push(item);
                            } else {
                                otherItems.push(item);
                            }
                        }

                        // EmojiProvider has one item per shortcode, so at most one is exact.
                        // Reorder the full list; let VS Code keep filtering fuzzy matches.
                        const nextItems = exactMatch
                            ? [exactMatch, ...prefixMatches, ...otherItems]
                            : [...prefixMatches, ...otherItems];
                        if (extraMatchesChanged || nextItems.some((item, index) => item !== displayedItems[index])) {
                            picker.items = nextItems;
                            displayedItems = nextItems;
                        }
                        const bestMatch = exactMatch || prefixMatches[0];
                        if (bestMatch) {
                            picker.activeItems = [bestMatch];
                        }
                    };
                    const updateDescriptionControls = () => {
                        const activeItems = picker.activeItems;
                        for (const item of rankedItems) {
                            item.description = itemDescriptionFor(item.emoji);
                            item.detail = descriptionDisplay === 'detail' ? descriptionFor(item.emoji) : undefined;
                        }
                        updateControls();
                        updateResults(picker.value);
                        // Refresh changed text even if result ordering did not change.
                        picker.items = displayedItems;
                        const { tags, text } = queryParts(picker.value);
                        const eligible = activeItems.filter(item => matchesTags(item, tags)
                            && [item.emoji.emoji, shortcodeFor(item.emoji), searchDescriptions ? descriptionFor(item.emoji) : '']
                                .some(field => matchesPickerQuery(text, field)));
                        if (eligible.length) {
                            picker.activeItems = eligible;
                        }
                    };
                    const cycleDisplay = () => {
                        descriptionDisplay = descriptionDisplay === 'no' ? 'description' : descriptionDisplay === 'description' ? 'detail' : 'no';
                        updateDescriptionControls();
                    };
                    const toggleSearch = () => {
                        searchDescriptions = !searchDescriptions;
                        updateDescriptionControls();
                    };
                    disposables.push(commands.registerCommand('emojisense.cyclePickerDescriptionDisplay', cycleDisplay));
                    disposables.push(commands.registerCommand('emojisense.togglePickerDescriptionSearch', toggleSearch));
                    disposables.push(picker.onDidChangeValue(updateResults));
                    disposables.push(picker.onDidAccept(() => {
                        resolve(picker.selectedItems[0]);
                        picker.hide();
                    }));
                    disposables.push(picker.onDidHide(() => {
                        resolve(undefined);
                    }));
                    void commands.executeCommand('setContext', 'emojisense.pickerOpen', true);
                    picker.show();
                });
            } finally {
                disposables.forEach(disposable => disposable.dispose());
                picker.dispose();
                void commands.executeCommand('setContext', 'emojisense.pickerOpen', false);
            }
            if (!selectedItem) {
                return;
            }

            const insert = textFor(selectedItem);
            switch (destination) {
                case 'terminal':
                    if (window.activeTerminal) {
                        window.activeTerminal.sendText(insert, false);
                        await remember(selectedItem.emoji.name);
                        await commands.executeCommand('workbench.action.terminal.focus');
                    }
                    break;
                case 'editor':
                    if (window.activeTextEditor) {
                        const editor = window.activeTextEditor;
                        const inserted = await editor.edit((builder) => builder.insert(editor.selection.active, insert));
                        if (inserted) {
                            await remember(selectedItem.emoji.name);
                        }
                    }
                    break;
            }
        };
    };
};
