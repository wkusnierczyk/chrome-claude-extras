// Fallback HTML -> Markdown converter, used only when the native Copy button
// can't be found or doesn't respond. Covers what Claude replies typically
// contain: headings, paragraphs, emphasis, links, lists, code, tables, quotes.
(() => {
  const SKIP = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT", "NOSCRIPT", "TEXTAREA", "INPUT"]);

  const escapeCell = (s) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

  function inline(node) {
    let out = "";
    for (const child of node.childNodes) out += convertInline(child);
    return out;
  }

  function convertInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag)) return "";
    switch (tag) {
      case "BR":
        return "  \n";
      case "STRONG":
      case "B": {
        const t = inline(node).trim();
        return t ? `**${t}**` : "";
      }
      case "EM":
      case "I": {
        const t = inline(node).trim();
        return t ? `*${t}*` : "";
      }
      case "DEL":
      case "S": {
        const t = inline(node).trim();
        return t ? `~~${t}~~` : "";
      }
      case "CODE": {
        const t = node.textContent;
        const fence = t.includes("`") ? "``" : "`";
        return `${fence}${t}${fence}`;
      }
      case "A": {
        const t = inline(node).trim();
        const href = node.getAttribute("href");
        return href ? `[${t || href}](${href})` : t;
      }
      case "IMG": {
        const src = node.getAttribute("src");
        return src ? `![${node.getAttribute("alt") || ""}](${src})` : "";
      }
      default:
        // Block elements nested inside inline context: flatten.
        if (isBlock(tag)) return block(node).trim();
        return inline(node);
    }
  }

  const BLOCKS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "HR", "TABLE",
  ]);
  const isBlock = (tag) => BLOCKS.has(tag);

  function list(node, depth) {
    const ordered = node.tagName.toUpperCase() === "OL";
    let n = parseInt(node.getAttribute("start") || "1", 10);
    const indent = "   ".repeat(depth);
    const lines = [];
    for (const li of node.children) {
      if (li.tagName.toUpperCase() !== "LI") continue;
      const marker = ordered ? `${n++}. ` : "- ";
      let text = "";
      const nested = [];
      for (const child of li.childNodes) {
        const t = child.nodeType === Node.ELEMENT_NODE ? child.tagName.toUpperCase() : "";
        if (t === "UL" || t === "OL") nested.push(list(child, depth + 1));
        else if (t === "P" || t === "DIV") text += (text ? " " : "") + inline(child).trim();
        else text += convertInline(child);
      }
      lines.push(indent + marker + text.trim());
      lines.push(...nested);
    }
    return lines.join("\n");
  }

  function table(node) {
    const rows = [...node.querySelectorAll("tr")].map((tr) =>
      [...tr.children].map((c) => escapeCell(inline(c)))
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill("")];
    const head = pad(rows[0]);
    const out = [`| ${head.join(" | ")} |`, `|${Array(width).fill("---").join("|")}|`];
    for (const r of rows.slice(1)) out.push(`| ${pad(r).join(" | ")} |`);
    return out.join("\n");
  }

  function block(node) {
    const parts = [];
    let buffer = "";
    const flush = () => {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = "";
    };
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE) {
        buffer += convertInline(child);
        continue;
      }
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (!isBlock(tag)) {
        buffer += convertInline(child);
        continue;
      }
      flush();
      let md = "";
      if (/^H[1-6]$/.test(tag)) md = "#".repeat(+tag[1]) + " " + inline(child).trim();
      else if (tag === "P") md = inline(child).trim();
      else if (tag === "UL" || tag === "OL") md = list(child, 0);
      else if (tag === "PRE") {
        const code = child.querySelector("code") || child;
        const lang = ((code.className || "").match(/language-([\w+-]+)/) || [])[1] || "";
        md = "```" + lang + "\n" + code.textContent.replace(/\n$/, "") + "\n```";
      } else if (tag === "BLOCKQUOTE")
        md = block(child).split("\n").map((l) => (l ? "> " + l : ">")).join("\n");
      else if (tag === "HR") md = "---";
      else if (tag === "TABLE") md = table(child);
      else md = block(child); // DIV, SECTION, ARTICLE, stray LI
      if (md.trim()) parts.push(md.trim());
    }
    flush();
    return parts.join("\n\n");
  }

  globalThis.cmdHtmlToMarkdown = (root) =>
    block(root).replace(/\n{3,}/g, "\n\n").trim() + "\n";
})();
