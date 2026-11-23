// A faster drop-in for make.fun's makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// run(input) returns exactly makefun-site 1.0.0's answer for every input: the output
// tree (path -> file text, byte for byte). Written from scratch against the reference
// program's rules (vendor/makefun-site/README.md); where the README and the reference
// code differ, the code's answer is the answer, so this file mirrors the code's
// behaviour exactly, only faster:
//
//  - Markdown: single-pass renderer, no token objects, regex jump-to-next-special
//    inline scanning, plain runs copied without escaping.
//  - Templates: parsed once, compiled to JS functions (new Function) with an
//    interpreted fallback; lookups share one helper.
//  - slugify: ASCII fast path + per-run() memoization (nothing cached across cases).
//  - Front matter: hand-written parser, same errors, same order of checks.
//  - Allocation discipline: body lines are split once and reused; word counts are
//    counted, never materialised as arrays.
//
// Node 22 only, dependency-free ES module, no WASM/native. All state lives inside
// run(): nothing is cached from one case to the next.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether char code `c` is JavaScript whitespace (\s): the full set. */
const SPACE_TABLE = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 160]) SPACE_TABLE[c] = 1;
function isSpaceCode(c) {
  if (c < 256) return SPACE_TABLE[c] === 1;
  return c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** A Unicode space character (one outside ASCII) anywhere in `s`. */
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/** The words of `lines` (joined by "\n"): runs of characters other than whitespace.
 * `uniSpace` is true when the source holds a Unicode space (then the full set applies). */
function wordsOfLines(lines, uniSpace) {
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li];
    if (uniSpace) {
      // Rare: a Unicode space is present, so the full set applies.
      let inWord = false;
      for (let i = 0; i < s.length; i++) {
        if (isSpaceCode(s.charCodeAt(i))) inWord = false;
        else if (!inWord) { inWord = true; n++; }
      }
    } else {
      // Lines hold no "\n"; only space and tab separate words here.
      let inWord = false;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 32 || c === 9) inWord = false;
        else if (!inWord) { inWord = true; n++; }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- text

/** The HTML escape table: & < > " ' only. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `s[a..b)` with & < > " ' escaped, pushed as chunks into `out`. */
function escInto(s, a, b, out) {
  ESC_RE.lastIndex = a;
  let m;
  let run = a;
  while ((m = ESC_RE.exec(s)) !== null && m.index < b) {
    if (m.index > run) out.push(s.slice(run, m.index));
    out.push(ESCAPES[m[0]]);
    run = m.index + 1;
    ESC_RE.lastIndex = run;
  }
  if (b > run) out.push(s.slice(run, b));
}

/** `s` with & < > " ' escaped. */
function escStr(s) {
  if (!ESC_TEST.test(s)) return s;
  const out = [];
  escInto(s, 0, s.length, out);
  return out.join('');
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Whether char code `c` is [a-zA-Z0-9]. */
function isAlnumCode(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
}

/** The slug of an all-ASCII `text` (NFKD is the identity on ASCII). */
function slugifyAscii(text) {
  const parts = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && !isAlnumCode(text.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && isAlnumCode(text.charCodeAt(i))) i++;
    parts.push(text.slice(start, i).toLowerCase());
  }
  let out = parts.join('-');
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, exactly as the reference (NFKD, combining marks dropped). */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const NON_ASCII = /[^\x00-\x7F]/;

/** The slug of `text`, memoized in `memo` (scoped to one run()). */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const out = NON_ASCII.test(text) ? slugifySlow(text) : slugifyAscii(text);
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` is blank (spaces and tabs only). */
function fmBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // ^(\d{4})-(\d{2})-(\d{2})$ + a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        // ^[a-z0-9]+(?:-[a-z0-9]+)*$
        let prevDash = true;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body lines from `lines` (its text split on "\n"):
 * { data, bodyLines }, or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (fmBlank(line) || line.charCodeAt(0) === 35) continue;
    // /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // trailing spaces and tabs dropped
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c !== 32 && c !== 9) break;
      e--;
    }
    raw = raw.slice(0, e);
    const key = line.slice(0, k);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** Next inline special: \ ` * [ & < > " '. Shared; inlineRange always resets lastIndex. */
const SCAN = /[\\`*\[&<>"']/g;
const WS_TEST = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[a..b)` rendered inline; `env.link(target)` is a link's href. Chunks go into `out`. */
function inlineRange(s, a, b, env, out) {
  let run = a;
  SCAN.lastIndex = a;
  let m;
  while ((m = SCAN.exec(s)) !== null && m.index < b) {
    const p = m.index;
    if (p > run) out.push(s.slice(run, p));
    const c = s.charCodeAt(p);
    let i;
    if (c === 92) {
      // backslash escape
      if (p + 1 < b && ESCAPABLE[s.charCodeAt(p + 1)] === 1) {
        out.push(s.charCodeAt(p + 1) === 62 ? '&gt;' : s[p + 1]);
        i = p + 2;
      } else {
        out.push('\\');
        i = p + 1;
      }
    } else if (c === 96) {
      // code span
      const j = s.indexOf('`', p + 1);
      if (j !== -1 && j < b && j > p + 1) {
        out.push('<code>');
        escInto(s, p + 1, j, out);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i = p + 1;
      }
    } else if (c === 42) {
      if (p + 1 < b && s.charCodeAt(p + 1) === 42) {
        // strong
        const j = findUnescaped(s, '**', p + 2, b);
        if (j > p + 2) {
          out.push('<strong>');
          inlineRange(s, p + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i = p + 2;
        }
      } else {
        // emphasis
        const j = findSingleStar(s, p + 1, b);
        if (j > p + 1) {
          out.push('<em>');
          inlineRange(s, p + 1, j, env, out);
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i = p + 1;
        }
      }
    } else if (c === 91) {
      // link
      const k = findUnescaped(s, ']', p + 1, b);
      let mm = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const t = s.indexOf(')', k + 2);
        if (t !== -1 && t < b) mm = t;
      }
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_TEST.test(target)) {
        const href = env.link(target);
        out.push('<a href="');
        escInto(href, 0, href.length, out);
        out.push('">');
        inlineRange(s, p + 1, k, env, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = p + 1;
      }
    } else {
      // & < > " '
      out.push(ESCAPES[s[p]]);
      i = p + 1;
    }
    run = i;
    SCAN.lastIndex = i;
  }
  if (b > run) out.push(s.slice(run, b));
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text span, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let a = d;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (a >= b) return null;
  return { depth: d, start: a, end: b };
}

/** Whether `line` is a thematic break (--- or ***, then spaces/tabs only). */
function isHR(line) {
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A list item's start: { ordered, start, text }, or null. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
  }
  return null;
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents and its excerpt (the first paragraph's inline HTML, or "").
 * `memo` is the run's slugify cache.
 */
function renderMarkdown(lines, env, memo) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const out = ['<pre><code'];
      if (lang !== '') {
        out.push(' class="language-');
        out.push(lang);
        out.push('"');
      }
      out.push('>');
      for (let k = 0; k < body.length; k++) {
        escInto(body[k], 0, body[k].length, out);
        out.push('\n');
      }
      out.push('</code></pre>');
      blocks.push(out.join(''));
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const text = line.slice(hd.start, hd.end);
      const id = uniqueSlug(slugify(text, memo), ids);
      const html = inlineStr(text, env);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        qlines.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = qlines.filter((l) => l !== '');
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else {
        const text = kept.join('\n');
        const out = ['<blockquote>\n<p>'];
        inlineRange(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>');
        blocks.push(out.join(''));
      }
      continue;
    }
    const lm = listMarker(line);
    if (lm !== null) {
      const ordered = lm.ordered;
      const items = [];
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === ordered) {
          items.push([trimLine(m2.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const out = [ordered && lm.start !== 1 ? `<ol start="${lm.start}">` : `<${tag}>`, '\n'];
      for (const parts of items) {
        out.push('<li>');
        const text = parts.length === 1 ? parts[0] : parts.join('\n');
        inlineRange(text, 0, text.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`);
      blocks.push(out.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const out = ['<p>'];
    inlineRange(text, 0, text.length, env, out);
    out.push('</p>');
    const html = out.join('');
    if (excerpt === null) excerpt = html.slice(3, -4);
    blocks.push(html);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` is spaces and tabs only. */
function onlySpacesTabs(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ---------------------------------------------------------------- template rendering

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function LK(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function TX(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(TX).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function TR(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The HTML escape, as a string (templates). */
function ES(s) {
  return escStr(s);
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }) into `out`. `parsed` holds the
 * parsed templates (a template that did not parse absent). The interpreted path,
 * used only if compilation is unavailable.
 */
function renderNodes(nodes, scope, parsed, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ES(TX(LK(scope, n.path))));
        break;
      case 'raw':
        out.push(TX(LK(scope, n.path)));
        break;
      case 'if': {
        const v = TR(LK(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, parsed, depth, out);
        break;
      }
      case 'for': {
        const xs = LK(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, parsed, depth, out);
        }
        break;
      }
      case 'include': {
        const t = parsed.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, parsed, depth + 1, out);
        break;
      }
    }
  }
}

/** Compile parsed `nodes` to a function (scope, depth, out). `F` is the map of compiled templates. */
function compileTemplate(nodes, F) {
  const lines = [];
  const consts = [];
  let uid = 0;
  const pathConst = (path) => {
    const id = `P${consts.length}`;
    consts.push(`${id}=${JSON.stringify(path)}`);
    return id;
  };
  const gen = (ns, scopeVar) => {
    for (const n of ns) {
      if (n.kind === 'text') lines.push(`s += ${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') lines.push(`s += ES(TX(LK(${scopeVar},${pathConst(n.path)})));`);
      else if (n.kind === 'raw') lines.push(`s += TX(LK(${scopeVar},${pathConst(n.path)}));`);
      else if (n.kind === 'if') {
        lines.push(`if (TR(LK(${scopeVar},${pathConst(n.path)})) !== ${n.not}) {`);
        gen(n.then, scopeVar);
        if (n.else !== null) {
          lines.push('} else {');
          gen(n.else, scopeVar);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
        const u = uid++;
        lines.push(`{ const _a${u} = LK(${scopeVar},${pathConst(n.path)}); if (Array.isArray(_a${u})) { for (let _k${u} = 0; _k${u} < _a${u}.length; _k${u}++) { const _s${u} = { vars: { ${JSON.stringify(n.name)}: _a${u}[_k${u}], loop: { index: _k${u} + 1, first: _k${u} === 0, last: _k${u} === _a${u}.length - 1, length: _a${u}.length } }, parent: ${scopeVar} };`);
        gen(n.body, `_s${u}`);
        lines.push('} } }');
      } else if (n.kind === 'include') {
        const u = uid++;
        lines.push(`if (depth < 8) { const _f${u} = F[${JSON.stringify(n.name)}]; if (_f${u} !== undefined) s += _f${u}(${scopeVar}, depth + 1); }`);
      }
    }
  };
  gen(nodes, 'scope');
  const src = `${consts.length ? `const ${consts.join(', ')};\n` : ''}return function (scope, depth) {\nlet s = '';\n${lines.join('\n')}\nreturn s;\n};`;
  return new Function('F', 'LK', 'TR', 'TX', 'ES', src)(F, LK, TR, TX, ES);
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether a link target is kept as written (a scheme, / or #). */
function linkKept(target) {
  const c0 = target.charCodeAt(0);
  if (c0 === 47 || c0 === 35) return true;
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
    for (let i = 1; i < target.length; i++) {
      const c = target.charCodeAt(i);
      if (c === 58) return true;
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
    }
  }
  return false;
}

/** One site's output tree: path -> text. */
function build(input) {
  const memo = new Map(); // slugify cache, this run() only
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile templates to JS functions; fall back to the interpreter if codegen
  // is unavailable in this runtime.
  const F = {};
  let compiled = true;
  try {
    for (const [name, nodes] of templates) F[name] = compileTemplate(nodes, F);
  } catch {
    compiled = false;
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled,
    F,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      b.sources.push({ path: f.path, lines: text.split('\n'), uniSpace: UNICODE_SPACE.test(text) });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, memo), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const resolveCache = new Map(); // (dir + "\0" + rel) -> resolved path or null, this run only
  const resolveCached = (dir, rel) => {
    const key = `${dir}\0${rel}`;
    const hit = resolveCache.get(key);
    if (hit !== undefined) return hit;
    const path = resolvePath(dir, rel);
    resolveCache.set(key, path);
    return path;
  };
  // One env object for all sources: its dir/src are set per source before rendering.
  const env = {
    dir: '',
    src: '',
    link(target) {
      if (linkKept(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveCached(this.dir, rel);
      if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      b.broken.add(`broken-link ${this.src} -> ${target}`);
      return target;
    },
  };
  for (const s of b.sources) {
    env.dir = dirOf(s.path);
    env.src = s.path;
    const md = renderMarkdown(s.bodyLines, env, memo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.bodyLines, s.uniSpace);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  /** A source's tags, each slug once (its slug computed once), in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, memo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  /** A post's card, as lists show it. */
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  /** A page as its layout reads it (its card's fields inlined, no intermediate card). */
  function pageOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const renderOut = []; // reused output buffer for every render (renders are sequential)
  const render = (name, scopeVars) => {
    const scope = { vars: scopeVars, parent: null };
    if (b.compiled) {
      const fn = b.F[name];
      if (fn === undefined) return null;
      return fn(scope, 0);
    }
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    renderOut.length = 0;
    renderNodes(nodes, scope, b.templates, 0, renderOut);
    return renderOut.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = b.input.site.per_page;
  const nPages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= nPages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: nPages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === nPages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const nPageSources = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${nPageSources} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
