import { commands, QuickPickItem, window } from 'vscode';
import { Emoji, EmojiProvider } from './emoji';

export type EmojiDestination = 'terminal' | 'editor';

export const quickEmoji = (provider: EmojiProvider) => {
    const items: QuickPickItem[] = provider.emojis.map((emoji) => {
        return ({ description: emoji.description, label: `${emoji.emoji}\t${emoji.name}`});
        /* TODO:
        - see usage of details: (details? emoji.description)
        - see if use kind
        - ! SPACE SUPPORT!
        link doc:  https://code.visualstudio.com/api/references/vscode-api#QuickPick&lt;T&gt;
        */
    });

    return (property: keyof Emoji, destination: EmojiDestination) => {
        return async () => {

            const emoji: QuickPickItem | undefined = await new Promise<QuickPickItem | undefined>((resolve) => {
                const picker = window.createQuickPick<QuickPickItem>();
                picker.items = items;
                picker.matchOnDescription = true; // ! FIXME: make it an option! + option to show or not the description
                picker.placeholder = 'Your Emoji Code';
                picker.title = property === 'emoji' ? 'Emoji Picker' : 'Emoji Code Picker';
                picker.onDidAccept(() => {
                    picker.hide();
                    resolve(picker.selectedItems[0]);
                });
                picker.onDidChangeValue(() => {
                    // Prune space related from input (not sure how to just ignore) 👾
                    const noSpace = picker.value.replace(/\s+/g, '');
                    if (noSpace !== picker.value) picker.value = noSpace;
                });
                picker.onDidHide(() => {
                    picker.dispose();
                    resolve(undefined);
                });
                picker.show();
            });
            if (!emoji) {
                return;
            }

            const insert = property === 'name' ? `:${emoji.description}:` : emoji.label || '';
            switch (destination) {
                case 'terminal':
                    if (window.activeTerminal) {
                        window.activeTerminal.sendText(insert, false);
                        await commands.executeCommand('workbench.action.terminal.focus');
                    }
                    break;
                case 'editor':
                    if (window.activeTextEditor) {
                        const editor = window.activeTextEditor;
                        await editor.edit((builder) => builder.insert(editor.selection.active, insert));
                    }
                    break;
            }
        };
    };
};
