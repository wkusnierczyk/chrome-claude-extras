// Adds a "Questions" section to the right-hand rail of a Claude Code session
// on claude.ai/code (beside Environment, Context, Outputs and Changes): the
// questions the session has asked, as the decide-pane mod writes them, read
// through the native host by the background worker. The session is matched
// by its Remote Control id, the one in the page's address.
(() => {
  // claude.ai's markup is not a public API. If an update breaks the section,
  // these selectors are the place to fix it. Its look is copied from the
  // rail's own sections at run time, so it follows the site's styling.
  const SEL = {
    section: "section[data-rail-section]",
    card: "[data-rail-card]",
    // The header row, its toggle button, and a section's list body.
    headerRow: ":scope > div:first-child",
    headerButton: "button",
    listBody: "[data-rail-panel] > div",
    // One row of a section's list, e.g. a file under Outputs.
    row: "[data-rail-panel] span[role][tabindex]",
    composer: [
      '[data-testid="code-prompt-input"]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
    ],
  };

  const POLL_MS = 3000;
  const MARK = "data-cce-questions";
  const HEADINGS = { open: "Open", progressing: "Progressing", answered: "Answered" };

  let questions = null; // null until the first reply for this session
  let lastShown = "";
  let isCollapsed = false;
  let isAnsweredOpen = false;
  let isPolling = false;

  const sessionId = () => (location.pathname.match(/^\/code\/(session_[A-Za-z0-9]+)/) || [])[1] || null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function toast(msg) {
    const node = el("div", { className: "cmd-toast", textContent: msg });
    document.body.appendChild(node);
    setTimeout(() => node.classList.add("cmd-toast-out"), 2200);
    setTimeout(() => node.remove(), 2700);
  }

  function safeLink(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  // Types "Q<n>: " into the message box without sending, or copies it.
  async function answer(q) {
    const text = `Q${q.n}: `;
    const box = SEL.composer.map((s) => document.querySelector(s)).find(Boolean);
    if (box) {
      box.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(box);
      sel.collapseToEnd();
      if (document.execCommand("insertText", false, text)) return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied "${text}" — paste it into the prompt`);
    } catch {
      toast("Couldn't reach the message box or the clipboard");
    }
  }

  // The rail's own classes, read off a section that has a list (Outputs,
  // Changes), else any section.
  function template() {
    const sections = [...document.querySelectorAll(SEL.section)].filter((s) => !s.closest(`[${MARK}]`));
    if (sections.length === 0) return null;
    const withRows = sections.find((s) => s.querySelector(SEL.row)) || sections[0];
    const headerRow = withRows.querySelector(SEL.headerRow);
    return {
      anchor: sections[Math.min(1, sections.length - 1)].closest(SEL.card),
      card: withRows.closest(SEL.card)?.className || "",
      section: withRows.className,
      headerRow: headerRow?.className || "",
      headerButton: headerRow?.querySelector(SEL.headerButton)?.className || "",
      listBody: withRows.querySelector(SEL.listBody)?.className || "",
      row: withRows.querySelector(SEL.row)?.className || "",
    };
  }

  function questionRow(q, t) {
    const link = q.link ? safeLink(q.link) : null;
    const row = el(
      "span",
      { className: `${t.row} cce-q`, role: "button", tabIndex: 0, title: `Answer Q${q.n}` },
      el("span", { className: "cce-q-n", textContent: `Q${q.n}` }),
      el(
        "span",
        { className: "cce-q-text" },
        q.issue ? el("span", { className: "cce-dim", textContent: `${q.issue} ` }) : null,
        q.question,
        q.state === "progressing" && q.note ? el("span", { className: "cce-warn", textContent: ` — still: ${q.note}` }) : null,
        q.state === "answered" && q.note ? el("span", { className: "cce-dim", textContent: ` — ${q.note}` }) : null,
        link ? " " : null,
        link ? el("a", { href: link, target: "_blank", rel: "noopener", textContent: "mock-up" }) : null,
      ),
    );
    row.addEventListener("click", (event) => {
      if (!event.target.closest("a")) answer(q);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      answer(q);
    });
    return row;
  }

  function build(t) {
    const list = questions || [];
    const byState = (state) => list.filter((q) => q.state === state);
    const pending = byState("open").length + byState("progressing").length;

    const toggle = el(
      "button",
      { className: t.headerButton, type: "button", ariaExpanded: String(!isCollapsed) },
      el("span", { textContent: "Questions" }),
      el("span", { className: "cce-dim cce-count", textContent: questions === null ? "" : ` ${pending} open` }),
    );
    toggle.addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      lastShown = "";
      render();
    });

    const body = el("div", { className: `${t.listBody} cce-body` });
    if (questions === null) {
      body.append(el("p", { className: "cce-dim cce-note", textContent: "No questions from this session yet." }));
    } else {
      for (const state of ["open", "progressing"]) {
        const rows = byState(state);
        if (rows.length === 0) continue;
        body.append(el("div", { className: "cce-head", textContent: `${HEADINGS[state]} (${rows.length})` }));
        rows.forEach((q) => body.append(questionRow(q, t)));
      }
      const answered = byState("answered");
      if (answered.length > 0) {
        const details = el(
          "details",
          { open: isAnsweredOpen },
          el("summary", { className: "cce-head", textContent: `Answered (${answered.length})` }),
          ...answered.map((q) => questionRow(q, t)),
        );
        details.addEventListener("toggle", () => (isAnsweredOpen = details.open));
        body.append(details);
      }
      if (list.length === 0) body.append(el("p", { className: "cce-dim cce-note", textContent: "No questions yet." }));
    }

    return el(
      "div",
      { className: t.card },
      el(
        "section",
        { className: t.section },
        el("div", { className: t.headerRow }, el("div", { className: "flex min-w-0 flex-1" }, toggle)),
        isCollapsed ? null : body,
      ),
    );
  }

  // Puts the section after the rail's second one (Context), or redraws it
  // when what it shows changed. A re-render of the rail that drops it puts
  // it back on the next mutation.
  function render() {
    const existing = document.querySelector(`[${MARK}]`);
    if (!sessionId()) {
      existing?.remove();
      return;
    }
    const t = template();
    if (!t || !t.anchor) return;
    const key = JSON.stringify([questions, isCollapsed]);
    if (existing && existing.isConnected && key === lastShown) return;
    lastShown = key;
    const card = build(t);
    card.setAttribute(MARK, "");
    if (existing) existing.replaceWith(card);
    else t.anchor.after(card);
  }

  function poll() {
    const id = sessionId();
    if (!id || isPolling || document.hidden) return;
    isPolling = true;
    chrome.runtime.sendMessage({ type: "questions", bridgeSessionId: id }, (reply) => {
      isPolling = false;
      if (chrome.runtime.lastError || !reply || id !== sessionId()) return;
      questions = Array.isArray(reply.questions) ? reply.questions : null;
      render();
    });
  }

  let scheduled = 0;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      if (!document.querySelector(`[${MARK}]`)) lastShown = "";
      render();
    }, 200);
  }).observe(document.body, { childList: true, subtree: true });

  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      questions = null;
      lastShown = "";
    }
    poll();
  }, POLL_MS);
  document.addEventListener("visibilitychange", poll);
  poll();
})();
