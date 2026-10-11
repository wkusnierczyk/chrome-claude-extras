// Adds four buttons under every finished Claude reply:
//   "⤓ .md"      – downloads that reply as a markdown file, instantly, in the browser
//   "✎ .md"      – sends Claude a prompt asking it to write that reply as a .md file
//   "✎ .pdf"     – sends Claude a prompt asking it to write that reply as a PDF document
//   "⚔ Critique" – sends Claude a prompt asking it to critically review that reply
(() => {
  // claude.ai's markup is not a public API. If an update breaks the buttons,
  // these selectors are the place to fix it.
  const SEL = {
    response: ".font-claude-response, .font-claude-message",
    // A whole assistant turn. In Code sessions (claude.ai/code) this is the only
    // marker; there are no font-claude-* classes there.
    message: '[data-testid="assistant-message"]',
    // The prose blocks of a Code-session turn: its text, without the tool-call
    // rows and action buttons that sit beside it.
    messageText: ".prose",
    streaming: '[data-is-streaming="true"]',
    finished: '[data-is-streaming="false"]',
    copyButton: [
      'button[data-testid="action-bar-copy"]',
      'button[aria-label="Copy"]',
      'button[aria-label="Copy response"]',
    ].join(", "),
    composer: [
      '[data-testid="code-prompt-input"]',
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="chat-input"] [contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    sendButton: [
      'button[data-testid="code-prompt-send"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
      // Code sessions also have a "Send feedback" button; never click that.
      'button[aria-label*="Send"]:not([aria-label*="feedback" i])',
    ],
  };

  const BAR_CLASS = "cmd-bar";

  const ICON_DOWNLOAD =
    '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3v10m0 0 4-4m-4 4-4-4M4 16h12"/></svg>';
  const ICON_ASK =
    '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 3.5a1.8 1.8 0 0 1 2.5 2.5L7 15l-3.5 1 1-3.5z"/><path d="M12 5l3 3"/></svg>';
  // Crossed sabers; the second blade is broken where it passes under the first.
  const ICON_CRITIQUE =
    '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 13.5Q6.5 9 4 2.5M6.5 13.5Q7.69 12.73 8.75 11.91M11.28 9.69Q14.47 6.46 16 2.5M12 15l3-3M13.5 13.5l2.8 2.8M12 15q.9 2.3 4.3 1.3M8 15l-3-3M6.5 13.5l-2.8 2.8M8 15q-.9 2.3-4.3 1.3"/></svg>';

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "cmd-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("cmd-toast-out"), 2200);
    setTimeout(() => el.remove(), 2700);
  }

  function slugFromMarkdown(md) {
    const heading = md.match(/^#{1,6}\s+(.+)$/m);
    const firstLine = md.split("\n").find((l) => l.trim());
    const source = (heading ? heading[1] : firstLine || "").replace(/[*_`#>[\]()]/g, "");
    const slug = source
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ł/g, "l").replace(/Ł/g, "L")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "");
    if (slug) return slug;
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `claude-reply-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Ask the MAIN-world script to intercept the next clipboard write, then click
  // Claude's own Copy button so we get the reply's original markdown.
  function captureViaCopyButton(copyBtn) {
    return new Promise((resolve) => {
      if (!copyBtn) return resolve(null);
      const id = Math.random().toString(36).slice(2);
      const root = document.documentElement;
      const finish = (text) => {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        if (root.getAttribute("data-cmd-arm") === id) root.removeAttribute("data-cmd-arm");
        resolve(text);
      };
      const onMsg = (e) => {
        const d = e.data;
        if (e.source !== window || !d || d.source !== "cmd-page" || d.id !== id) return;
        finish(d.text);
      };
      // If nothing is captured within 1.5 s, disarm so normal copying works again.
      const timer = setTimeout(() => finish(null), 1500);
      window.addEventListener("message", onMsg);
      root.setAttribute("data-cmd-arm", id); // synchronous; see capture.js
      copyBtn.click();
    });
  }

  function findComposer() {
    for (const sel of SEL.composer) {
      const all = [...document.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
      if (all.length) return all[all.length - 1];
    }
    return null;
  }

  function findSendButton() {
    for (const sel of SEL.sendButton) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  // The parts of a reply that are its text. A regular chat's reply body is all
  // text; a Code-session turn also holds tool-call rows and its action bar.
  function textParts(responseEl) {
    if (!responseEl.matches(SEL.message)) return [responseEl];
    const parts = [...responseEl.querySelectorAll(SEL.messageText)].filter(
      (el) => !el.parentElement.closest(SEL.messageText)
    );
    return parts.length ? parts : [responseEl];
  }

  function isLatestResponse(responseEl) {
    const messages = document.querySelectorAll(SEL.message);
    if (messages.length) return messages[messages.length - 1].contains(responseEl);
    const all = document.querySelectorAll(SEL.response);
    return all.length && all[all.length - 1] === responseEl;
  }

  // ---------- button actions ----------

  async function onDownload(responseEl, copyBtn, button) {
    button.disabled = true;
    try {
      let md = await captureViaCopyButton(copyBtn);
      if (!md || !md.trim()) {
        md = textParts(responseEl)
          .map((el) => globalThis.cmdHtmlToMarkdown(el).trim())
          .filter(Boolean)
          .join("\n\n");
      }
      if (!md.endsWith("\n")) md += "\n";
      const filename = slugFromMarkdown(md) + ".md";
      downloadText(md, filename);
      toast(`Downloaded ${filename}`);
    } catch (err) {
      console.error("[Extras for Claude]", err);
      toast("Couldn't create the markdown file");
    } finally {
      button.disabled = false;
    }
  }

  // What each Ask button asks for, after naming the reply ("your last reply" or
  // a quote of an earlier one). A PDF is meant for print, so Claude is asked to
  // write a document from the reply rather than copy the chat text verbatim.
  const ASK = {
    md: (reply) => `Write ${reply} down as a markdown (.md) file.`,
    pdf: (reply) =>
      `Write ${reply} up as a PDF document. Give it a title and sections, ` +
      "drop conversational asides and references to earlier messages, and keep " +
      "its content and conclusions. Produce it as a .pdf file.",
    critique: (reply) =>
      `Critically review ${reply}. Provide evidence for and against its claims. ` +
      "Clarify whether opinions about it converge or are polarised.",
  };

  async function onAsk(responseEl, format) {
    let reply;
    if (isLatestResponse(responseEl)) {
      reply = "your last reply";
    } else {
      const snippet = textParts(responseEl)
        .map((el) => el.innerText ?? el.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ").trim().slice(0, 80);
      reply = `your earlier reply that begins with "${snippet}…"`;
    }
    const prompt = ASK[format](reply);

    const composer = findComposer();
    if (!composer) {
      await navigator.clipboard.writeText(prompt).catch(() => {});
      toast("Couldn't find the message box. The prompt is on your clipboard.");
      return;
    }

    composer.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(composer);
    sel.collapseToEnd();
    const hasText = (composer.innerText ?? composer.textContent ?? "").trim().length > 0;
    document.execCommand("insertText", false, (hasText ? " " : "") + prompt);

    // Give the editor a moment to enable the send button.
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const send = findSendButton();
      if (send && !send.disabled && send.getAttribute("aria-disabled") !== "true") {
        send.click();
        return;
      }
    }
    toast("Prompt typed. Press Enter to send.");
  }

  // ---------- injection ----------

  function makeButton(html, label, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cmd-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = `${html}<span>${label}</span>`;
    return b;
  }

  function makeBar(responseEl, copyBtn) {
    const bar = document.createElement("span");
    bar.className = BAR_CLASS;

    const dl = makeButton(ICON_DOWNLOAD, ".md", "Download this reply as a markdown file");
    dl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onDownload(responseEl, copyBtn, dl);
    });

    const askMd = makeButton(ICON_ASK, ".md", "Ask Claude to write this reply as a .md file");
    askMd.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAsk(responseEl, "md");
    });

    const askPdf = makeButton(ICON_ASK, ".pdf", "Ask Claude to write this reply as a PDF document");
    askPdf.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAsk(responseEl, "pdf");
    });

    const critique = makeButton(ICON_CRITIQUE, "Critique", "Ask Claude to critically review this reply");
    critique.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAsk(responseEl, "critique");
    });

    bar.append(dl, askMd, askPdf, critique);
    return bar;
  }

  // From a Copy button, find the single Claude reply it belongs to.
  function responseForCopyButton(btn) {
    // Code sessions: the turn itself is the reply (it has no separate body element).
    const message = btn.closest(SEL.message);
    if (message) return message.querySelector(SEL.response) || message;
    let node = btn.parentElement;
    for (let i = 0; node && i < 12; i++, node = node.parentElement) {
      const found = node.querySelectorAll(SEL.response);
      if (found.length === 1) return found[0];
      if (found.length > 1) return null; // climbed past one message: it's a user-message button
    }
    return null;
  }

  // React may re-render and drop our bar, so track the bar itself, not a flag.
  const bars = new WeakMap(); // response element -> injected bar
  const firstSeen = new WeakMap(); // response element -> time it was first seen finished
  const hasBar = (el) => bars.get(el)?.isConnected;

  function scan() {
    // Primary: sit next to Claude's own Copy button in each reply's action bar.
    for (const btn of document.querySelectorAll(SEL.copyButton)) {
      if (btn.closest("." + BAR_CLASS)) continue;
      const responseEl = responseForCopyButton(btn);
      if (!responseEl || responseEl.closest(SEL.streaming)) continue;
      const existing = bars.get(responseEl);
      if (existing?.isConnected) {
        if (!existing.classList.contains("cmd-bar-standalone")) continue;
        existing.remove(); // upgrade a fallback bar once the Copy button shows up
      }
      const bar = makeBar(responseEl, btn);
      bars.set(responseEl, bar);
      btn.insertAdjacentElement("afterend", bar);
    }

    // Fallback: finished replies that still have no recognisable Copy button
    // two seconds after finishing. Not used in Code sessions: there a running
    // turn flips to data-is-streaming="false" while it waits on a tool, and the
    // Copy button only renders on hover, which the primary path handles.
    const now = Date.now();
    for (const wrapper of document.querySelectorAll(SEL.finished)) {
      const responseEl = wrapper.querySelector(SEL.response);
      if (!responseEl || hasBar(responseEl)) continue;
      if (!firstSeen.has(responseEl)) {
        firstSeen.set(responseEl, now);
        setTimeout(schedule, 2100);
        continue;
      }
      if (now - firstSeen.get(responseEl) < 2000) continue;
      const bar = makeBar(responseEl, null);
      bar.classList.add("cmd-bar-standalone");
      bars.set(responseEl, bar);
      wrapper.insertAdjacentElement("afterend", bar);
    }
  }

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 300);
  };

  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-is-streaming"],
  });
  scan();
})();
