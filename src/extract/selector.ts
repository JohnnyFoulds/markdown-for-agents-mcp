// Minimal CSS selector extraction for common patterns:
// tag, #id, .class, tag.class, tag#id
// Complex selectors (descendants, pseudo-classes) are passed through unchanged
// as a best-effort fallback (full HTML returned).

interface SimpleSelector {
  tag?: string;
  id?: string;
  cls?: string;
}

function parseSimpleSelector(sel: string): SimpleSelector | null {
  const trimmed = sel.trim();

  // tag#id or tag.class
  const compound = trimmed.match(/^([a-zA-Z][a-zA-Z0-9]*)([#.][a-zA-Z0-9_-]+)$/);
  if (compound) {
    const tag = compound[1]!;
    const modifier = compound[2]!;
    if (modifier.startsWith('#')) return { tag, id: modifier.slice(1) };
    return { tag, cls: modifier.slice(1) };
  }

  // #id only
  if (trimmed.startsWith('#')) {
    const id = trimmed.slice(1);
    if (/^[a-zA-Z0-9_-]+$/.test(id)) return { id };
    return null;
  }

  // .class only
  if (trimmed.startsWith('.')) {
    const cls = trimmed.slice(1);
    if (/^[a-zA-Z0-9_-]+$/.test(cls)) return { cls };
    return null;
  }

  // plain tag
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(trimmed)) {
    return { tag: trimmed };
  }

  return null;
}

function buildOpenTagPattern(sel: SimpleSelector): RegExp {
  const tagPat = sel.tag ? sel.tag : '[a-zA-Z][a-zA-Z0-9]*';

  if (sel.id) {
    return new RegExp(`<(${tagPat})[^>]+id=["']${escapeRe(sel.id)}["'][^>]*>`, 'i');
  }
  if (sel.cls) {
    // Match class attribute containing cls as a whole word:
    // - optionally skip preceding classes (anything up to a space)
    // - lookahead: cls must be followed by whitespace or closing quote
    return new RegExp(
      `<(${tagPat})[^>]*class=["'](?:[^"']*\\s)?${escapeRe(sel.cls)}(?=[\\s"'])[^>]*>`,
      'i',
    );
  }
  return new RegExp(`<(${tagPat})(?:\\s[^>]*)?>`, 'i');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractElement(html: string, openTagRe: RegExp): string | null {
  const match = openTagRe.exec(html);
  if (!match) return null;

  const tagName = match[1]!;
  const start = match.index;
  let depth = 0;
  // Start scanning from after the opening tag so we don't count it again
  let i = start + match[0].length;

  while (i < html.length) {
    const openRe = new RegExp(`<${tagName}(?:\\s|>)`, 'gi');
    const closeRe = new RegExp(`</${tagName}>`, 'gi');

    openRe.lastIndex = i;
    closeRe.lastIndex = i;

    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);

    if (!nextClose) break;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      i = nextOpen.index + 1;
    } else {
      if (depth === 0) {
        return html.slice(start, nextClose.index + nextClose[0].length);
      }
      depth--;
      i = nextClose.index + 1;
    }
  }

  // Self-closing or no close tag — return from match to end of tag
  return html.slice(start, start + match[0].length);
}

export function applyIncludeSelector(html: string, selector: string): string {
  const parsed = parseSimpleSelector(selector);
  if (!parsed) return html; // complex selector — return full HTML

  const pattern = buildOpenTagPattern(parsed);
  const extracted = extractElement(html, pattern);
  return extracted ?? html;
}

export function applyExcludeSelectors(html: string, selectors: string[]): string {
  let result = html;
  for (const sel of selectors) {
    const parsed = parseSimpleSelector(sel);
    if (!parsed) continue; // skip complex selectors

    const pattern = buildOpenTagPattern(parsed);
    // Remove all matching elements
    let replaced = result;
    let found: RegExpExecArray | null;

    while ((found = pattern.exec(replaced)) !== null) {
      // Reset so extractElement's internal exec re-scans from the start
      pattern.lastIndex = 0;
      const element = extractElement(replaced, pattern);
      if (!element) break;
      const idx = replaced.indexOf(element);
      if (idx === -1) break;
      replaced = replaced.slice(0, idx) + replaced.slice(idx + element.length);
      pattern.lastIndex = 0;
    }
    result = replaced;
  }
  return result;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}
