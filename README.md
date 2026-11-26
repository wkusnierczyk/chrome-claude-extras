# chrome-claude-extras

**Extras for Claude** is a Chrome extension with small quality-of-life additions to [claude.ai](https://claude.ai), and a Claude Code mod that goes with it.

Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic.

## Features

### Reply buttons

Four buttons under every reply, next to the native Copy button. Works in regular chats and in Claude Code sessions on the web (claude.ai/code). In Code sessions a reply's actions, and so these buttons, appear when you hover over the reply.

| Button | What it does |
|---|---|
| **⤓ .md** | Downloads that reply as a markdown file, instantly, without another turn. The file name comes from the reply's first heading. |
| **✎ .md** | Types and sends a prompt asking Claude to write that reply as a `.md` file, so Claude produces a proper file in the chat. |
| **✎ .pdf** | Types and sends a prompt asking Claude to write that reply up as a PDF document: a title, sections and no chat asides, with the reply's content kept. Claude produces the `.pdf` in the chat. |
| **⚔ Critique** | Types and sends a prompt asking Claude to critically review that reply: evidence for and against its claims, and whether opinions on it converge or are polarised. |

### Clear and Questions

Two sections in a Claude Code session's right-hand sidebar on claude.ai/code, after *Context*, and the same in a Chrome side panel.

**Clear** says whether the session may be cleared now, as the terminal status line says it: from the session's own word, which it records with `~/.claude/session-state.sh busy|done "<why>"` in `~/.claude/session-state/<session id>.json`, and from the context's size.

| Shows | When |
|---|---|
| **Don't clear yet** | The session said `busy`; its reason follows, and when it was set if over 6 hours ago. |
| **Clear now** | The session said `done`, and the context holds 60k tokens or more. |
| **Clear when you like** | The session said `done`, with a smaller context. |
| **Clear at the next boundary** | Nothing recorded, and the context holds 300k tokens or more. |
| **Nothing recorded** | Neither. |

The heading carries the verdict, so it reads folded too; the body adds the reason and the context's size.

**Questions** lists the questions a Claude Code session has asked you, by state: **Open**, **Progressing** (answered in part, or waiting on a follow-up only you can settle, with what is still missing) and **Answered** (folded, with the answer). Numbers stay stable across the session (`Q1`, `Q2`, …), in the same style as `/decide` (the mod numbers its own list, so the two can differ). A mock-up link opens in a new tab.

- **In the sidebar.** The sections show the session the page shows, found by its Remote Control id (the `session_…` in the address), and refreshes every 3 seconds while the tab is visible. Click its heading to fold it; click a question to type `Q3: ` into the message box, to answer by number (where the box is not found, `Q3: ` is copied instead). Its look is copied from the sidebar's own sections as the page draws them.
- **In the side panel.** Click the extension's toolbar button. It shows the session updated most recently, and its menu switches to any other running session; click a question to copy `Q3: `.

It is meant for sessions started in a terminal and opened on claude.ai/code over Remote Control: a Claude Code mod can draw a pane in the terminal, but the claude.ai page does not draw mod panes.

Three parts make it work:

- **The `decide-pane` mod** (`claude-code/decide-pane/`). After each reply it asks a fork of the session which questions it has asked you and their state, draws them in a terminal pane (`/questions` opens it), and writes them to `~/.claude/decide-pane/sessions/<session id>.json` with the session's directory, repository, Remote Control id and context size. The fork reuses the session's prompt cache, but each one is a model request billed like any other.
- **A native messaging host** (`host/claude_extras_host.py`, Python 3 standard library). Chrome cannot read local files, so the panel asks this small program, which Chrome starts on demand, for those files, each with the session's clear state from `~/.claude/session-state/`. It skips sessions that ended, and deletes their files after an hour; a session not updated for a week is taken as gone and its file deleted too.
- **The sidebar sections and the side panel** (`extension/rail.js`, `extension/sidepanel.*`). Content scripts cannot reach a native host, so the sections ask the background worker (`background.js`), which asks the host.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Reload any open claude.ai tabs.

For the Questions panel, also:

5. Register the native host (macOS and Linux; needs `python3`):

   ```sh
   host/install.sh
   ```

   It registers the host for Chrome and for Chromium, Brave, Edge or Arc where installed. On Linux it does not cover Chrome Beta, Dev or Canary, and a snap or flatpak browser usually cannot start native hosts at all. Run it again after moving the repository; `host/install.sh --uninstall` removes it.

6. Install the mod, at the prompt of a Claude Code session in a terminal:

   ```
   /plugin install decide-pane --marketplace wkusnierczyk/chrome-claude-extras
   ```

   Answer `y` to add the marketplace, then pick the user scope so it runs in every session.

The extension's ID is fixed by the `key` in `manifest.json` (`oadhipdbgcnjhfcfiblhihcjdhlcilic`), which the host's registration names as the one extension allowed to call it. A Chrome Web Store build would get an ID of its own (the store refuses `key`), which `allowed_origins` in `host/install.sh` would then have to list.

It works in any Chromium browser that supports Manifest V3 with `world: "MAIN"` content scripts (Chrome 111+, Edge, Brave, Arc).

## How the reply buttons work

**Download.** The reply's original markdown is already available through Claude's own Copy button. The extension briefly arms a hook on `navigator.clipboard` (running in the page's own JS world, `capture.js`), programmatically clicks Copy, and catches the text before it reaches your clipboard. Your clipboard is left untouched. Arming uses a `data-cmd-arm` attribute on `<html>` because the DOM is shared with the extension's isolated world and, unlike `postMessage`, is synchronous, so the hook is armed before the click fires.

If the Copy button can't be found or doesn't respond within 1.5 seconds, the extension converts the rendered HTML to markdown instead (`html2md.js`). That covers headings, emphasis, links, nested lists, code blocks, tables and quotes, but is less exact than the native copy.

**Ask.** The prompt is inserted into the message box with `execCommand("insertText")`, which the ProseMirror editor treats like real typing, then the Send button is clicked. For the latest reply the prompt says "your last reply". For older replies it quotes the reply's first 80 characters so Claude knows which one you mean. The .pdf button does no rendering in the browser: a chat reply printed verbatim makes a poor document, so it asks Claude to write one from the reply instead. If the Send button doesn't become active, the prompt stays in the box and you press Enter yourself.

## Privacy

The reply buttons run only on `https://claude.ai/*`. The extension makes no network requests and stores nothing. Downloads are created locally from a `Blob`.

The Questions feature adds two permissions: `sidePanel`, to show the panel, and `nativeMessaging`, to ask the native host for the questions files. The host only reads `~/.claude/decide-pane/sessions/` (and deletes ended sessions' files there) and `~/.claude/session-state/`, and answers this extension alone. A small background worker sets the toolbar button to open the panel and passes the host's answer to the sidebar section; nothing leaves your machine. The mod writes only to that folder; its forks go to the model the session already uses, on your own credentials.

## When claude.ai changes

claude.ai's markup is not a public API, so an update to the site can break the buttons. All selectors live in the `SEL` object at the top of `extension/content.js`:

| Key | Finds |
|---|---|
| `response` | The rendered body of a Claude reply |
| `message` | A whole assistant turn; the only reply marker in Code sessions |
| `streaming`, `finished` | Reply wrappers while generating and once done |
| `copyButton` | Claude's native Copy button in the action bar |
| `composer` | The message input |
| `sendButton` | The Send button |

The Clear and Questions sections have a `SEL` object of their own at the top of `extension/rail.js`: the sidebar's sections, their cards, header row and button, list body and rows, and the message box.

If the native Copy button stops being recognised, buttons still appear in a fallback row under each finished reply in regular chats, using the HTML converter.

## Files

```
extension/
  manifest.json   Manifest V3: content scripts, side panel, fixed key
  capture.js      MAIN-world clipboard hook
  html2md.js      Fallback HTML to markdown converter
  content.js      Button injection and actions
  styles.css      Button and toast styling
  rail.js         Clear and Questions sections in a Code session's sidebar
  background.js   Toolbar button opens the side panel; relays the host to rail.js
  sidepanel.html  Questions panel
  sidepanel.js    Polls the native host, draws the questions
  sidepanel.css   Panel styling, light and dark
host/
  claude_extras_host.py  Native messaging host: reads the mod's files
  install.sh             Registers the host with the browsers
claude-code/decide-pane/ The Claude Code mod
.claude-plugin/marketplace.json  Makes this repository a marketplace for the mod
```

## License

[Apache License 2.0](LICENSE)
