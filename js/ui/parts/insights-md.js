// Insights (UI-D): tiny sanitizing markdown renderer for AI answers.
// Safety model: the whole input is HTML-escaped FIRST; afterwards only a fixed set of tags without
// attributes derived from the text is added (p, br, strong, em, del, code, pre, ul, ol, li, h4, h5,
// blockquote, hr, table markup). No raw HTML, no links, no images, no inline styles.
// Supported: paragraphs, **bold**, *italic* / _italic_, ~~strike~~, `code`, fenced code blocks,
// - / * / 1. lists (one nesting level by indentation), # headings, > quotes, ---, and pipe tables.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeMd = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const CODE_TOKEN = '\u0000C';
const NUMERIC_CELL = /^[−+-]?[$€£]?\d[\d,]*(\.\d+)?\s?(%|[a-zA-Z/µ°]{0,6})?$/;

/** Inline formatting on ALREADY-ESCAPED text. */
export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return CODE_TOKEN + (codes.length - 1) + '\u0000'; });
  // Links and images: keep the label only (no navigation or remote content from AI text).
  s = s.replace(/!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1');
  s = s.replace(/\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*/g, '<strong>$1</strong>').replace(/__([^\s_](?:[^\n]*?[^\s_])?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^\s_](?:[^_\n]*[^\s_])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^\s~](?:[^\n]*?[^\s~])?)~~/g, '<del>$1</del>');
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const RE = {
  fence: /^\s*```/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}&gt;\s?(.*)$/,
  ul: /^(\s*)[-*+•]\s+(.*)$/,
  ol: /^(\s*)(\d{1,3})[.)]\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};
const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-');

/** Markdown → safe HTML string. */
export function renderMarkdown(src) {
  const lines = escapeMd(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }

    if (RE.fence.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !RE.fence.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }
    const h = RE.heading.exec(line);
    if (h) { flush(); const tag = h[1].length <= 2 ? 'h4' : 'h5'; out.push(`<${tag}>${inline(h[2])}</${tag}>`); continue; }
    if (RE.hr.test(line)) { flush(); out.push('<hr>'); continue; }

    if (isTableStart(lines, i)) {
      flush();
      const head = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map((c) => (/:$/.test(c) && !/^:/.test(c) ? 'num' : ''));
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      i--;
      const numCol = head.map((_, c) => aligns[c] === 'num' || (rows.length > 0 && rows.every((r) => !r[c] || NUMERIC_CELL.test(r[c].replace(/&[a-z#0-9]+;/g, '')))));
      const cell = (tag, c, v) => `<${tag}${numCol[c] ? ' class="num"' : ''}>${inline(v || '')}</${tag}>`;
      out.push('<div class="table-wrap"><table class="data"><thead><tr>' + head.map((v, c) => cell('th', c, v)).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, c) => cell('td', c, r[c])).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }

    const q = RE.quote.exec(line);
    if (q) {
      flush();
      const body = [q[1]];
      while (i + 1 < lines.length && RE.quote.test(lines[i + 1])) body.push(RE.quote.exec(lines[++i])[1]);
      out.push(`<blockquote>${body.filter((x) => x.trim()).map(inline).join('<br>')}</blockquote>`);
      continue;
    }

    if (RE.ul.test(line) || RE.ol.test(line)) {
      flush();
      i = list(lines, i, out) - 1;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

// Parses a list starting at `start`; returns the index after it. One nested level by indentation.
function list(lines, start, out) {
  const first = RE.ol.exec(lines[start]) || RE.ul.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = !!RE.ol.exec(lines[start]);
  const tag = ordered ? 'ol' : 'ul';
  const items = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1];
      if (next && (RE.ul.test(next) || RE.ol.test(next))) continue;
      break;
    }
    const m = RE.ol.exec(line) || RE.ul.exec(line);
    if (m) {
      const indent = m[1].length;
      const text = RE.ol.exec(line) ? m[3] : m[2];
      if (indent > baseIndent + 1 && items.length) { items[items.length - 1].sub.push({ ordered: !!RE.ol.exec(line), text }); continue; }
      if (indent < baseIndent) break;
      if (!!RE.ol.exec(line) !== ordered && indent === baseIndent) break;
      items.push({ text, sub: [], more: [] });
      continue;
    }
    if (/^\s{2,}\S/.test(line) && items.length) { items[items.length - 1].more.push(line.trim()); continue; }
    if (RE.heading.test(line) || RE.quote.test(line) || RE.fence.test(line) || isTableStart(lines, i)) break;
    if (items.length) { items[items.length - 1].more.push(line.trim()); continue; } // lazy continuation
    break;
  }
  const li = (it) => {
    const body = [it.text, ...it.more].map(inline).join('<br>');
    if (!it.sub.length) return `<li>${body}</li>`;
    const subTag = it.sub[0].ordered ? 'ol' : 'ul';
    return `<li>${body}<${subTag}>${it.sub.map((s) => `<li>${inline(s.text)}</li>`).join('')}</${subTag}></li>`;
  };
  out.push(`<${tag}>${items.map(li).join('')}</${tag}>`);
  return i;
}
