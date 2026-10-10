# chrome-claude-extras

**Extras for Claude** is a Chrome extension with small quality-of-life additions to [claude.ai](https://claude.ai).

Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.

## Features

### Markdown buttons

Two buttons under every reply, next to the native Copy button.

| Button | What it does |
|---|---|
| **.md** | Downloads that reply as a markdown file, instantly, without another turn. The file name comes from the reply's first heading. |
| **Ask .md** | Types and sends a prompt asking Claude to write that reply as a `.md` file, so Claude produces a proper file in the chat. |

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Reload any open claude.ai tabs.

It works in any Chromium browser that supports Manifest V3 with `world: "MAIN"` content scripts (Chrome 111+, Edge, Brave, Arc).

## How the markdown buttons work

**Download.** The reply's original markdown is already available through Claude's own Copy button. The extension briefly arms a hook on `navigator.clipboard` (running in the page's own JS world, `capture.js`), programmatically clicks Copy, and catches the text before it reaches your clipboard. Your clipboard is left untouched. Arming uses a `data-cmd-arm` attribute on `<html>` because the DOM is shared with the extension's isolated world and, unlike `postMessage`, is synchronous, so the hook is armed before the click fires.

If the Copy button can't be found or doesn't respond within 1.5 seconds, the extension converts the rendered HTML to markdown instead (`html2md.js`). That covers headings, emphasis, links, nested lists, code blocks, tables and quotes, but is less exact than the native copy.

**Ask.** The prompt is inserted into the message box with `execCommand("insertText")`, which the ProseMirror editor treats like real typing, then the Send button is clicked. For the latest reply the prompt says "your last reply". For older replies it quotes the reply's first 80 characters so Claude knows which one you mean. If the Send button doesn't become active, the prompt stays in the box and you press Enter yourself.

## Privacy

The extension requests no permissions beyond running on `https://claude.ai/*`. It makes no network requests, stores nothing, and has no background worker. Downloads are created locally from a `Blob`.

## When claude.ai changes

claude.ai's markup is not a public API, so an update to the site can break the buttons. All selectors live in the `SEL` object at the top of `extension/content.js`:

| Key | Finds |
|---|---|
| `response` | The rendered body of a Claude reply |
| `streaming`, `finished` | Reply wrappers while generating and once done |
| `copyButton` | Claude's native Copy button in the action bar |
| `composer` | The message input |
| `sendButton` | The Send button |

If the native Copy button stops being recognised, buttons still appear in a fallback row under each finished reply, using the HTML converter.

## Files

```
extension/
  manifest.json   Manifest V3, content scripts only
  capture.js      MAIN-world clipboard hook
  html2md.js      Fallback HTML to markdown converter
  content.js      Button injection and actions
  styles.css      Button and toast styling
```

## License

[Apache License 2.0](LICENSE)
