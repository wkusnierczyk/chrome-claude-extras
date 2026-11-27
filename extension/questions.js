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
    // A section's card. The rail draws the line above a section from this
    // attribute on its card, so the section's own card carries it too.
    card: "[data-rail-card]",
    cardAttr: "data-rail-card",
    // The header row, its fold button, and the chevron icon inside it.
    headerRow: ":scope > div:first-child",
    headerButton: "button",
    chevron: 'button > [data-cds="Icon"]',
    // A section's list body, and one row of it, e.g. a file under Outputs.
    listBody: "[data-rail-panel] > div",
    row: "[data-rail-panel] span[role][tabindex]",
    // The section to go after, by its title; else the rail's second.
    anchorTitle: "Context",
    composer: [
      '[data-testid="code-prompt-input"]',
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="chat-input"] [contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
  };
  // The list classes where no section has an open list to copy them from
  // (Outputs and Changes folded), as the rail had them.
  const FALLBACK = {
    listBody: "flex flex-col pt-1 px-sm",
    row: "flex min-h-6.5 w-full min-w-0 items-center gap-sm px-xs text-body rounded hover:bg-fill-ghost-hover",
  };
  // A folded section's chevron points right; an open one's shows on hover.
  const CHEVRON_FOLDED = ["-rotate-90", "page-rtl:rotate-90"];
  const CHEVRON_OPEN = [
    "opacity-0",
    "group-hover/railtop:opacity-100",
    "group-focus-within/railtop:opacity-100",
    "touch:opacity-100",
  ];

  const POLL_MS = 3000;
  // Replies in a row without the session (its file mid-write) that keep
  // the list shown before it is dropped.
  const KEEP_MISSES = 2;
  const MARK = "data-cce-questions";
  const HEADINGS = { open: "Open", progressing: "Progressing", answered: "Answered" };

  // What is shown, and for which session: a list is never drawn on another
  // session's page, even for the moment before that page's first reply.
  let shownFor = null;
  let questions = null; // null until a reply has the session
  let misses = 0; // replies in a row without the session
  let error = "";
  let lastShown = "";
  let isCollapsed = false;
  let isAnsweredOpen = false;
  let isPolling = false;
  let timer = 0;
  let observer = null;

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

  // The visible message box, the last one, as content.js finds it; its
  // editable element where the match is a wrapper.
  function findComposer() {
    for (const sel of SEL.composer) {
      const all = [...document.querySelectorAll(sel)].filter((node) => node.offsetParent !== null);
      if (all.length === 0) continue;
      const box = all[all.length - 1];
      return box.isContentEditable ? box : box.querySelector('[contenteditable="true"]');
    }
    return null;
  }

  // Types "Q<n>: " at the end of the message box without sending, or copies it.
  async function answer(q) {
    const text = `Q${q.n}: `;
    const box = findComposer();
    if (box) {
      box.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(box);
      sel.collapseToEnd();
      const hasText = (box.innerText ?? box.textContent ?? "").trim().length > 0;
      if (document.execCommand("insertText", false, (hasText ? " " : "") + text)) return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied "${text}" — paste it into the prompt`);
    } catch {
      toast("Couldn't reach the message box or the clipboard");
    }
  }

  const titleOf = (section) => section.querySelector(SEL.headerRow)?.querySelector(SEL.headerButton)?.textContent.trim() || "";

  // The rail's own classes, read off a section that has a list (Outputs,
  // Changes), else any section; the chevron from any section.
  function template() {
    const sections = [...document.querySelectorAll(SEL.section)].filter((s) => !s.closest(`[${MARK}]`));
    if (sections.length === 0) return null;
    const withRows = sections.find((s) => s.querySelector(SEL.row)) || sections[0];
    const headerRow = withRows.querySelector(SEL.headerRow);
    const anchor = sections.find((s) => titleOf(s).startsWith(SEL.anchorTitle)) || sections[Math.min(1, sections.length - 1)];
    return {
      anchor: anchor.closest(SEL.card),
      card: withRows.closest(SEL.card)?.className || "",
      section: withRows.className,
      headerRow: headerRow?.className || "",
      headerButton: headerRow?.querySelector(SEL.headerButton)?.className || "",
      chevron: sections.map((s) => s.querySelector(SEL.chevron)).find(Boolean) || null,
      listBody: withRows.querySelector(SEL.listBody)?.className || FALLBACK.listBody,
      row: withRows.querySelector(SEL.row)?.className || FALLBACK.row,
    };
  }

  function chevron(t) {
    if (!t.chevron) return null;
    const icon = t.chevron.cloneNode(true);
    icon.classList.remove(...CHEVRON_FOLDED, ...CHEVRON_OPEN);
    icon.classList.add(...(isCollapsed ? CHEVRON_FOLDED : CHEVRON_OPEN));
    if (isCollapsed) icon.removeAttribute("data-open");
    else icon.setAttribute("data-open", "");
    return icon;
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
    // A held key repeats into the message box once it has the focus, where
    // Enter would send; act on the first press only.
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (!event.repeat) answer(q);
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
      el("span", { className: "shrink-0", textContent: "Questions" }),
      el("span", { className: "cce-dim cce-count", textContent: questions === null ? "" : ` ${pending} open` }),
      chevron(t),
    );
    toggle.addEventListener("click", () => {
      isCollapsed = !isCollapsed;
      lastShown = "";
      render();
    });

    const body = el("div", { className: `${t.listBody} cce-body` });
    if (error) body.append(el("p", { className: "cce-warn cce-note", textContent: error }));
    if (questions === null) {
      if (!error) body.append(el("p", { className: "cce-dim cce-note", textContent: "No questions from this session yet." }));
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

    const section = el(
      "section",
      { className: t.section },
      el("div", { className: t.headerRow }, el("div", { className: "flex min-w-0 flex-1" }, toggle)),
      isCollapsed ? null : body,
    );
    if (!isCollapsed) section.setAttribute("data-open", "");
    const card = el("div", { className: t.card }, section);
    card.setAttribute(SEL.cardAttr, "");
    card.setAttribute(MARK, "");
    return card;
  }

  // Forgets what was shown when the page moved to another session.
  function follow() {
    const id = sessionId();
    if (id === shownFor) return false;
    shownFor = id;
    questions = null;
    misses = 0;
    error = "";
    lastShown = "";
    return true;
  }

  // Puts the section after Context, or redraws it when what it shows
  // changed. A re-render of the rail that drops it puts it back on the next
  // mutation.
  function render() {
    const moved = follow();
    const existing = document.querySelector(`[${MARK}]`);
    if (!shownFor) {
      existing?.remove();
      return;
    }
    if (moved) poll();
    const t = template();
    if (!t || !t.anchor) return;
    const key = JSON.stringify([shownFor, questions, error, isCollapsed]);
    if (existing && existing.isConnected && key === lastShown) return;
    lastShown = key;
    const card = build(t);
    if (existing) existing.replaceWith(card);
    else t.anchor.after(card);
  }

  // The extension was reloaded or removed: this copy can no longer reach it,
  // and the new one is not injected into open tabs, so step aside.
  function retire() {
    clearInterval(timer);
    observer?.disconnect();
    document.querySelector(`[${MARK}]`)?.remove();
  }

  function poll() {
    const id = sessionId();
    if (!id || isPolling || document.hidden) return;
    if (!chrome.runtime?.id) {
      retire();
      return;
    }
    isPolling = true;
    try {
      chrome.runtime.sendMessage({ type: "questions", bridgeSessionId: id }, (reply) => {
        isPolling = false;
        if (id !== sessionId()) return;
        if (chrome.runtime.lastError || !reply || reply.error) {
          // Keep the last list; say why it is not updating.
          error = `Not updating: ${chrome.runtime.lastError?.message || reply?.error || "no reply"}`;
        } else {
          // The mod could not refresh the list: show the one it kept, and why.
          const why = reply.isEnded ? "" : reply.sessionError || "";
          error = why && why[0].toUpperCase() + why.slice(1);
          // A session missing from a reply or two (its file mid-write) keeps
          // its list; longer, or ended (cleared or quit), it is gone.
          const list = Array.isArray(reply.questions) && !reply.isEnded ? reply.questions : null;
          misses = list || reply.isEnded ? 0 : misses + 1;
          if (list || reply.isEnded || misses > KEEP_MISSES) questions = list;
        }
        render();
      });
    } catch {
      isPolling = false;
      retire();
    }
  }

  let scheduled = 0;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      if (!document.querySelector(`[${MARK}]`)) lastShown = "";
      render();
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  timer = setInterval(() => {
    follow();
    poll();
  }, POLL_MS);
  document.addEventListener("visibilitychange", poll);
  poll();
})();
