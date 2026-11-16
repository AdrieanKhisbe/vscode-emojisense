import { Uri } from 'vscode';

/** Cache icons by glyph so aliases and subsequent picker openings reuse them. */
export const createEmojiIconProvider = () => {
    const icons = new Map<string, Uri>();
    return (emoji: string): Uri => {
        let icon = icons.get(emoji);
        if (!icon) {
            // Character references preserve joined emoji and keep text out of SVG markup.
            const text = Array.from(emoji, char => `&#x${char.codePointAt(0)!.toString(16)};`).join('');
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                <text x="16" y="26" text-anchor="middle" font-size="28" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${text}</text>
            </svg>`;
            icon = Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
            icons.set(emoji, icon);
        }
        return icon;
    };
};
