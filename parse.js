// SwiftMark — a fast CommonMark 0.31.2 + GFM 0.29 parser.
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// default options (gfm true, breaks false, pedantic false, async false).
// Written from scratch from the CommonMark and GFM specifications and the
// behaviour of the reference outputs; no third-party code is used.

// ---------------------------------------------------------------------------
// Escaping. marked escapes text with "no encode": < > " ' always, and &
// only when it is not part of what looks like an entity reference.
// Code spans and code blocks escape with "encode": every one of & < > " '.
// ---------------------------------------------------------------------------

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML, decoding valid numeric character references.
// A valid numeric reference (&#123; 1-7 digits, &#x1F600; 1-6 hex digits)
// decodes to its character (0, surrogates and >0x10FFFF become U+FFFD);
// a named-entity-like sequence (&name;) passes through unchanged; any
// other & is escaped to &amp;.
const ESCAPE_TEXT_RE = /&#(\d{1,7});|&#[Xx]([0-9a-fA-F]{1,6});|&[A-Za-z][A-Za-z0-9]*;|&|<|>|"|'/g;

export function escapeEncode(s) {
  return s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1
    ? s
    : s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

export function escapeText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ESCAPE_TEXT_RE, (m, dec, hex) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
      const ch = String.fromCodePoint(cp);
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      if (ch === "'") return '&#39;';
      return ch;
    }
    if (m.length > 1) return m; // named-entity-like: pass through
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    if (m === '"') return '&quot;';
    return '&#39;';
  });
}

// ---------------------------------------------------------------------------
// URL cleaning: marked runs a destination through encodeURI, then restores
// any %25 back to % (so an already-encoded %20 survives). A null result
// (encodeURI throwing on a lone surrogate) means the link is dropped.
// ---------------------------------------------------------------------------

export function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const PUNCT_ESCAPES = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

function isPunct(ch) {
  return PUNCT_ESCAPES.has(ch);
}

// Unicode punctuation for flanking rules: CommonMark defines a punctuation
// character as Unicode general category P or S (so £ and € count).
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  return ch !== undefined && UNICODE_PUNCT_RE.test(ch);
}

function isSpace(ch) {
  // Unicode whitespace for flanking rules (CommonMark): ASCII whitespace
  // plus U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
  // U+205F, U+3000, U+FEFF (the same set as JavaScript \s).
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0x85 || c === 0xa0 || c === 0x1680 || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff ||
    (c >= 0x2000 && c <= 0x200a);
}

function isWhitespace(ch) {
  // CommonMark whitespace: space, tab, newline, vertical tab, form feed, CR.
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Full Unicode case folding for label matching (CommonMark): ß/ẞ fold
// to "ss", Greek final sigma ς folds to σ, and the Latin ligatures fold
// to their expansions. (String.toLowerCase alone leaves ß as ß.)
function caseFold(s) {
  return s.toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Normalise a link label for reference lookup: collapse inner whitespace
// (including newlines) to single spaces, trim, and fold case.
export function normalizeLabel(label) {
  return caseFold(label.replace(/\s+/g, ' ').trim());
}

// Find the closing ']' of a link label starting at s[start] === '['.
// Skips backslash escapes; an unescaped '[' inside ends the label
// (invalid). Returns the index of ']' or -1.
function findLabelEnd(s, start) {
  let i = start + 1;
  let len = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isPunct(s[i + 1])) { i += 2; len += 2; continue; }
    if (c === '[') return -1;
    if (c === ']') {
      if (len === 0) return -1;
      return i;
    }
    i++;
    len++;
    if (len > 999) return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Nodes are kept in a flat array. A node is either a string (plain text,
// stored raw and escaped at render time) or an object:
//   {t:'code', s}             code span (raw content, newlines already folded)
//   {t:'delim', ch, len, canOpen, canClose, active, node}  emphasis delimiter
//   {t:'bracket', image, active}   '[' (or '![') that may form a link
//   {t:'link', href, title, open:true}   '[' converted to a link opener
//   {t:'image', href, title, start, end} image (text range for its alt)
//   {t:'html', s}             raw inline HTML
//   {t:'br'}                  hard break
//   {t:'soft'}                soft break (renders as '\n')
//   {t:'del', s}              strikethrough (content parsed at scan time)
//   {t:'em_open'|'em_close'|'strong_open'|'strong_close', ch}
//   {t:'autolink', href, text}  <...> autolink or extended autolink
// Delimiter and bracket nodes that never match render as their literal text.

// The characters that can start an inline construct (and therefore end a
// run of plain text). '@' ends a run so an email's local part can be found
// by looking back; 'www.' and a scheme followed by :// are found by the
// same scan; a bare scheme is found by a zero-width lookahead.
const NEXT_SPECIAL = /[*_`\[\]!<>\\~`\n@]|www\.|(?=[a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s<>])/g;
// Fast-path gate: if none of these occur, the string is plain text
// (a lone \n is a soft break, which escapeText preserves).
const INLINE_SLOW = /[*_`\[\]!<>\\~@]|www\.|:\/\/|  \n/;

// Characters that may appear in the local part of an email address.
const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]/;
// Characters that may appear in a domain label.
const DOMAIN_LABEL = /[a-zA-Z0-9-]/;

// Extended autolink: www. followed by a valid domain and optional path.
const WWW_RE = /www\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+[^\s<>]*/y;
// A bare scheme autolink: scheme ':' rest. If the rest starts with // it
// is a hierarchical URL and runs to the end; otherwise it has no '/' at
// all, or exactly one '/' segment (marked stops a non-// scheme before a
// second /).
const SCHEME_RE = /([a-zA-Z][a-zA-Z0-9+.\-]{1,31}):(\/\/[^\s<>]*|[^\s<>\/]*(?:\/[^\s<>\/]*)?)/y;
// Email: local part @ domain.
const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;
// Domain part only (used by the @ handler, which finds the local part in
// the pending text and the domain in the source after @).
const DOMAIN_RE = /[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;

// Punctuation stripped from the end of an extended autolink (GFM backpedal).
// A trailing ';' is punctuation and is stripped for both www. and scheme
// autolinks, even after a plain domain (http://github.com; links as
// http://github.com); a ';' inside the URL (followed by a URL character,
// e.g. http://github.com/a;b) is part of the URL and is kept.
function backpedalUrl(url) {
  let end = url.length;
  // An unclosed '(' truncates the URL: find the last ')' in the URL;
  // the first '(' after it has no ')' after it, so the URL ends just
  // before that '(' (marked stops a bare autolink there: the '(' of a
  // following (… ) group that never closes is not part of the link).
  const lastClose = url.lastIndexOf(')', end - 1);
  const firstOpenAfter = url.indexOf('(', lastClose + 1);
  if (firstOpenAfter >= 0 && firstOpenAfter < end) end = firstOpenAfter;
  // Strip a trailing ';' that looks like part of an entity reference.
  // (An '&' followed by word characters and ';' at the end.)
  if (end > 0 && url.charCodeAt(end - 1) === 59 /* ; */) {
    let i = end - 2;
    while (i >= 0 && /[a-zA-Z0-9#]/.test(url[i])) i--;
    if (i >= 0 && url[i] === '&') end = i;
  }
  // Balance parentheses: if there are more ')' than '(' in the link,
  // strip trailing ')' characters until balanced. Removing a ')' can
  // expose trailing punctuation (e.g. "open:.)" -> "open:."), so loop
  // the punctuation strip + paren balance until the end is stable.
  let prevEnd = -1;
  while (end !== prevEnd) {
    prevEnd = end;
    // Strip trailing punctuation ? ! . , : * _ ~ ' and a trailing ';'
    // (a ';' is punctuation at the end of an autolink for www. and
    // scheme URLs alike; inside the URL it is kept).
    while (end > 0) {
      const ch = url[end - 1];
      if ('? ! . , : * _ ~ \''.indexOf(ch) !== -1) { end--; continue; }
      if (ch === ';') { end--; continue; }
      break;
    }
    // A trailing ')' is stripped only when it is unmatched: scanning
    // the URL left to right, '(' raises the depth and ')' lowers it
    // (floored at 0); a ')' that closes an earlier '(' is kept, so an
    // unmatched ')' before a '(' does not make a later matched ')'
    // look excess (doc-37: ...example.com)](http://...) keeps its ')').
    if (end > 0 && url[end - 1] === ')') {
      let depth = 0;
      for (let i = 0; i < end - 1; i++) {
        if (url[i] === '(') depth++;
        else if (url[i] === ')') { if (depth > 0) depth--; }
      }
      if (depth === 0) end--;
    }
  }
  return url.slice(0, end);
}

// Try to match an extended autolink at position i of s. Returns
// {href, text, end} or null. The match is validated here (domain, scheme).
function matchExtendedAutolink(s, i, suppressed) {
  // While the <a>-tag suppression flag is on (see the <a> handling
  // in inlineToHtml), no bare autolink forms (doc-30/doc-03/doc-06).
  // Explicit [text](url) links and <...> autolinks are unaffected.
  if (suppressed) return null;
  WWW_RE.lastIndex = i;
  let m = WWW_RE.exec(s);
  if (m) {
    let url = backpedalUrl(m[0]);
    if (url.length === 0) return null;
    // The href runs through cleanUrl (encodeURI) like every other link,
    // so a backslash in the URL becomes %5C (doc-40: www.flux.com\).
    const href = 'http://' + url;
    return { href: cleanUrl(href) || href, text: url, end: i + url.length };
  }
  SCHEME_RE.lastIndex = i;
  m = SCHEME_RE.exec(s);
  if (m) {
    // A scheme autolink needs a non-empty rest after the colon.
    if (m[2].length === 0) return null;
    // mailto: takes an email address after the scheme, not a generic URL
    // path (so a trailing / is not part of the link, and a trailing -
    // or _ invalidates it like a bare email). xmpp: takes a JID, which
    // may include a /resource, so it uses the generic scheme match.
    const scheme = m[1].toLowerCase();
    if (scheme === 'mailto') {
      EMAIL_RE.lastIndex = i + m[1].length + 1;
      const em = EMAIL_RE.exec(s);
      if (!em) return null;
      const end = i + m[1].length + 1 + em[0].length;
      // A trailing - or _ invalidates, except a _ that starts an
      // emphasis run (next char is also _).
      if (s[end] === '-' || (s[end] === '_' && s[end + 1] !== '_')) return null;
      const url = m[1] + ':' + em[0];
      return { href: url, text: url, end };
    }
    let url = backpedalUrl(m[0]);
    if (url.length === 0) return null;
    // A lone trailing ';' (no query string) invalidates the autolink.
    if (url.charCodeAt(url.length - 1) === 59 /* ; */) return null;
    // A backslash immediately before a newline is a hard break, not part
    // of the URL — but only for a non-hierarchical scheme (tests:\,
    // at:\, server:?\): then it is not an autolink at all. For a
    // hierarchical URL (http://...\) the backslash is part of the URL
    // and is percent-encoded by cleanUrl (doc-40).
    if (url.charCodeAt(url.length - 1) === 92 /* \ */ && s[i + url.length] === '\n') {
      if (url.indexOf('://') === -1) return null;
    }
    // The rest after the scheme colon must survive backpedaling: if the
    // "rest" was only punctuation (e.g. "Warning:**" where the ** are
    // emphasis), the backpedaled URL collapses to the bare scheme and
    // is not an autolink at all.
    const colonAt = url.indexOf(':');
    if (colonAt < 0 || colonAt === url.length - 1) return null;
    // The href runs through cleanUrl (encodeURI) like every other link.
    return { href: cleanUrl(url) || url, text: url, end: i + url.length };
  }
  EMAIL_RE.lastIndex = i;
  m = EMAIL_RE.exec(s);
  if (m) {
    const url = m[0];
    const end = i + url.length;
    // A trailing - or _ after the domain invalidates it, except a _
    // that starts an emphasis run (next char is also _).
    if (s[end] === '-' || (s[end] === '_' && s[end + 1] !== '_')) return null;
    return { href: 'mailto:' + url, text: url, end };
  }
  return null;
}

// <...> autolink or email autolink. Returns {href, text, end} or null.
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s<>]*)>/y;
const EMAIL_AUTOLINK_RE = /<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/y;

function matchAngleAutolink(s, i) {
  AUTOLINK_RE.lastIndex = i;
  let m = AUTOLINK_RE.exec(s);
  if (m) {
    return { href: m[1], text: m[1], end: i + m[0].length };
  }
  EMAIL_AUTOLINK_RE.lastIndex = i;
  m = EMAIL_AUTOLINK_RE.exec(s);
  if (m) {
    return { href: 'mailto:' + m[1], text: m[1], end: i + m[0].length };
  }
  return null;
}

// Inline HTML: comment, processing instruction, declaration, CDATA,
// open tag, closing tag. Returns the matched length or 0.
const HTML_COMMENT_RE = /<!-->|<!--->|<!--(?:(?!-->)[\s\S])*?-->/y;
const HTML_PI_RE = /<\?(?:(?!\?>)[\s\S])*?\?>/y;
const HTML_DECL_RE = /<![A-Za-z][\s\S]*?>/y;
const HTML_CDATA_RE = /<!\[CDATA\[(?:(?!\]\]>)[\s\S])*?\]\]>/y;
const HTML_TAG_RE = /(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\r\n"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)/y;

function matchHtmlTag(s, i) {
  HTML_COMMENT_RE.lastIndex = i;
  let m = HTML_COMMENT_RE.exec(s);
  if (m) return m[0].length;
  HTML_PI_RE.lastIndex = i;
  m = HTML_PI_RE.exec(s);
  if (m) return m[0].length;
  HTML_DECL_RE.lastIndex = i;
  m = HTML_DECL_RE.exec(s);
  if (m) return m[0].length;
  HTML_CDATA_RE.lastIndex = i;
  m = HTML_CDATA_RE.exec(s);
  if (m) return m[0].length;
  HTML_TAG_RE.lastIndex = i;
  m = HTML_TAG_RE.exec(s);
  if (m) return m[0].length;
  return 0;
}

// Strikethrough: marked matches ~{1,2} not followed by ~ or space, content
// not starting/ending with ~ or space, closed by ~{1,2}. A run of 3+ tildes
// never opens. The closing run must not be part of a longer run (a ~~~~
// closer cannot close a ~~ opener), so it is followed by (?![~]).
// The closer must be the same length as the opener (backreference
// \1): a single ~ inside a ~~...~~ must not close it (doc-22:
// ~~version lexer tool ~pull using~ config~~ forms the outer del
// with the inner ~pull using~ as a nested del; a single ~ closer
// would end the outer del at `using` instead). The content may end
// with an escaped tilde `\~` (doc-15: `~~run \~~~` has content
// `run ~`, the `\~` being a literal ~ and the remaining `~~` the
// closer) — but not with an unescaped ~, which would be part of a
// longer tilde run (doc-14: `~~string ~on~~~` stays literal).
const DEL_RE = /(~{1,2})(?=[^\s~])([\s\S]*?(?:[^\s~]|\\~))\1(?![~])/y;

function matchDel(s, i) {
  DEL_RE.lastIndex = i;
  const m = DEL_RE.exec(s);
  if (!m) return null;
  // The opener is capture group 1 (same length as the closer via
  // the backreference); content is group 2.
  const openLen = m[1].length;
  let content = m[2];
  let end = i + m[0].length;
  // A run of 3+ tildes inside the content is an invalid closer: the
  // opener does not skip past it to a later ~~ (doc-14: ~~string
  // ~on~~~ stays literal even though a later ~~private~~ exists in
  // the same paragraph). The match fails instead.
  if (/~~~/.test(content)) return null;
  // Nesting: if the content has an odd number of ~~ runs, an inner
  // opener is unmatched and the match closed too early (~~a ~~b~~ c~~
  // must pair the outer ~~ with the last one, so the inner ~~b~~ can
  // form inside). Extend to the next valid closer until balanced.
  while (((content.match(/~~/g) || []).length % 2) === 1) {
    const k = s.indexOf('~~', end);
    if (k < 0) break;
    if (k === 0 || isSpace(s[k - 1]) || s[k - 1] === '~') break;
    if (s[k + 2] === '~') { end = k + 2; continue; }
    content = s.slice(i + openLen, k);
    end = k + 2;
  }
  return { content, end };
}

// ---------------------------------------------------------------------------
// Link parsing helpers
// ---------------------------------------------------------------------------

// Parse a link destination starting at i (after the opening '(' or after
// the label). Returns {dest, end} where end is the index just past the
// destination, or null. dest is the raw destination (unescaped later).
function parseLinkDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    // <...> destination: no line endings, no unescaped < or >.
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: out, end: j + 1 };
      if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) {
        out += s[j + 1];
        j += 2;
      } else {
        out += c;
        j++;
      }
    }
    return null;
  }
  // Bare destination: no spaces, no control chars, balanced parens.
  let j = i;
  let out = '';
  let parens = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === '(') {
      parens++;
      if (parens > 32) return null;
      out += c;
      j++;
      continue;
    }
    if (c === ')') {
      if (parens === 0) break;
      parens--;
      out += c;
      j++;
      continue;
    }
    out += c;
    j++;
  }
  if (out.length === 0) return null;
  return { dest: out, end: j };
}

// Parse a link title starting at i (after whitespace following the
// destination). Returns {title, end} or null. The title may span lines
// but not blank lines; backslash escapes are processed.
function parseLinkTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  let close;
  if (q === '"') close = '"';
  else if (q === "'") close = "'";
  else if (q === '(') close = ')';
  else return null;
  let j = i + 1;
  let out = '';
  let lastNonspace = -1;
  while (j < n) {
    const c = s[j];
    if (c === close) {
      return { title: out, end: j + 1 };
    }
    if (c === '\n') {
      // A blank line inside a title is not allowed.
      if (j + 1 < n && s[j + 1] === '\n') return null;
      out += '\n';
      j++;
      continue;
    }
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) {
      out += s[j + 1];
      j += 2;
      continue;
    }
    if (c === '(' && close === ')') return null;
    out += c;
    j++;
  }
  return null;
}

// Skip spaces, tabs and newlines. Returns the new index.
function skipSpace(s, i) {
  const n = s.length;
  while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse the inside of an inline link's parentheses, starting at the '('.
// Returns {dest, title, end} (end just past ')') or null.
function parseInlineLinkTail(s, i) {
  // s[i] === '('
  const n = s.length;
  let j = skipSpace(s, i + 1);
  if (j >= n) return null;
  if (s[j] === ')') return { dest: '', title: null, end: j + 1 };
  const d = parseLinkDestination(s, j);
  if (!d) return null;
  j = d.end;
  // After the destination: optional whitespace, optional title, optional
  // whitespace, then ')'.
  let k = skipSpace(s, j);
  if (k < n && s[k] === ')') return { dest: d.dest, title: null, end: k + 1 };
  if (k === j) return null; // destination must be followed by space or ')'
  const t = parseLinkTitle(s, k);
  if (!t) return null;
  k = skipSpace(s, t.end);
  if (k < n && s[k] === ')') return { dest: d.dest, title: t.title, end: k + 1 };
  return null;
}

// ===================== Inline parsing =====================

// Find the next interesting position >= from in s.
// Returns {pos, kind} where kind is 'char' (a single special char),
// 'www' (a valid www autolink starts here) or 'scheme' (a valid scheme
// autolink starts here); or null.
function findNext(s, from, suppressed) {
  let searchFrom = from;
  const n = s.length;
  while (searchFrom <= n) {
    NEXT_SPECIAL.lastIndex = searchFrom;
    const m = NEXT_SPECIAL.exec(s);
    if (!m) return null;
    const pos = m.index;
    const tok = m[0];
    // A www./scheme autolink must start at a word boundary (not preceded
    // by a letter, digit, or scheme character).
    const prevCh = pos > 0 ? s[pos - 1] : '';
    const atBoundary = prevCh === '' || !/[a-zA-Z0-9+.\-]/.test(prevCh);
    if (tok === 'www.') {
      if (atBoundary && matchExtendedAutolink(s, pos, suppressed)) return { pos, kind: 'www' };
      searchFrom = pos + 4;
      continue;
    }
    if (tok === '') {
      if (atBoundary && matchExtendedAutolink(s, pos, suppressed)) return { pos, kind: 'scheme' };
      searchFrom = pos + 1;
      continue;
    }
    return { pos, kind: 'char' };
  }
  return null;
}

// Plain text of nodes[start..end) — for image alt text.
function renderPlainText(nodes, start, end) {
  let out = '';
  for (let k = start; k < end; k++) {
    const nd = nodes[k];
    if (nd === undefined) continue;
    if (typeof nd === 'string') { out += nd; continue; }
    switch (nd.t) {
      case 'code': out += nd.s; break;
      case 'autolink': out += nd.text; break;
      case 'link': out += renderPlainText(nodes, nd.start, nd.end); k = nd.end; break;
      case 'image': out += renderPlainText(nodes, nd.start, nd.end); k = nd.end; break;
      case 'bracket': out += nd.image ? '![' : '['; break;
      case 'html': out += nd.s; break;
      case 'soft': case 'br': out += '\n'; break;
      case 'delim': if (nd.len > 0) out += nd.ch.repeat(nd.len); break;
      case 'raw': out += nd.s.replace(/<[^>]*>/g, ''); break;
      default: break;
    }
  }
  return out;
}

// Emphasis resolution (CommonMark Appendix A, phase 2) over the flat
// delimiter list. Delimiter nodes accumulate open/close tags; the
// renderer emits them in the right order.
function processEmphasis(delims, boundaries, triggers, codeSpans) {
  // Ranges [start, end) of delimiter indices that emphasis may not cross:
  // link/image text (passed in) plus emphasis already formed. An opener
  // and a closer at different nesting levels (one inside a range, the
  // other outside it) cannot pair.
  const ranges = boundaries ? boundaries.slice() : [];
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !closer.canClose) continue;
    let oi = ci - 1;
    while (oi >= 0) {
      const opener = delims[oi];
      if (!opener.active || opener.ch !== closer.ch || !opener.canOpen) { oi--; continue; }
      // Rule of 3: if either can both open and close, the sum of the
      // lengths must not be a multiple of 3 unless both are.
      if ((opener.canClose || closer.canOpen) &&
          (opener.len + closer.len) % 3 === 0 &&
          (opener.len % 3 !== 0 || closer.len % 3 !== 0)) { oi--; continue; }
      // A single-delimiter closer must not split a double-delimiter
      // opener when a double-delimiter closer follows and the opener
      // would be left too short to pair with it as strong emphasis
      // (opener len 2 minus 1 leaves 1, but the later closer needs 2).
      // If the opener is longer (len 3+), splitting is fine: the later
      // closer still finds 2 (cm-430: ***foo* bar**).
      if (closer.len === 1 && opener.len === 2) {
        let laterStrong = false;
        for (let k = ci + 1; k < delims.length; k++) {
          const d = delims[k];
          if (d.active && d.ch === closer.ch && d.canClose && d.len >= 2) { laterStrong = true; break; }
        }
        if (laterStrong) { oi--; continue; }
      }
      // A single-delimiter opener must not pair across an inner
      // strong whose opener is open-only and whose closer can both
      // open and close (doc-07/11/22/26/29: *… **X**Y* with a
      // space before the inner strong and none after it — the outer
      // * stays literal). When the inner closer is close-only
      // (cm-410: *foo **bar** baz*) or the inner opener can also
      // close (cm-411: *foo**bar**baz*), the outer em forms.
      // The inner strong is exactly the two delimiters between
      // opener and closer (both already consumed, len 0). An inner
      // *em* (not strong) does not block: *a *b*c* closes at the
      // first * after c (doc-26). The blocked opener is dead: no
      // later closer can pair with it either, since any such pair
      // would cross the same inner strong (doc-11: the inner *
      // must not pair with the closing ** either, so the ** forms
      // strong with the opening **).
      if (closer.len === 1 && opener.len === 1 && ci - oi === 3) {
        const d1 = delims[oi + 1], d2 = delims[oi + 2];
        if (!d1.active && !d2.active && d1.ch === closer.ch && d2.ch === closer.ch &&
            d1.canOpen && !d1.canClose && d2.canOpen && d2.canClose &&
            d1.opens.includes('strong') && d2.closes.includes('strong')) { opener.active = false; oi--; continue; }
      }
      // Nesting: no boundary may separate opener/closer.
      let crossed = false;
      for (let r = 0; r < ranges.length; r++) {
        const s = ranges[r][0], e = ranges[r][1];
        if ((oi >= s && oi < e) !== (ci >= s && ci < e)) { crossed = true; break; }
      }
      if (crossed) { oi--; continue; }
      break;
    }
    if (oi < 0) continue;
    const opener = delims[oi];
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    // Run-span trigger + later code span suppresses emphasis: when an
    // inline link/image whose label holds a mismatched backtick run
    // ends before this closer, and a code span starts after the
    // closer, the emphasis renders literally. This covers _ (em and
    // strong) and ** strong, but not single * em — unless the * em
    // contains a suppressed **, in which case deactivating the whole
    // closer run here kills the outer * pairing too (the closer is
    // deactivated entirely, not just shortened by `use`).
    if ((opener.ch === '_' || use === 2) &&
        triggers && triggers.length > 0 && triggers[0] <= closer.pos &&
        codeSpans && codeSpans.length > 0 && codeSpans[codeSpans.length - 1] > closer.pos) {
      opener.active = false;
      closer.active = false;
      continue;
    }
    const tag = use === 2 ? 'strong' : 'em';
    opener.opens.push(tag);
    closer.closes.push(tag);
    opener.len -= use;
    closer.len -= use;
    // A closer run with leftover length renders the leftover after
    // its close tags (cm-446: **foo*** -> </strong>*). But when the
    // run forms a strong and immediately follows a delimiter that
    // closed an inner em, the leftover belongs inside the strong,
    // before the close tag (doc-11/30: **… *old*two*** ->
    // two*</strong>, not two</strong>*). An em closer keeps the
    // leftover after the tag (doc-04/27: *… *else*returns** ->
    // returns</em>*).
    if (tag === 'strong' && closer.len > 0 && ci > 0) {
      const prev = delims[ci - 1];
      if (!prev.active && prev.closes.includes('em')) closer.litFirst = true;
    }
    ranges.push([oi + 1, ci]);
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) closer.active = false;
    else ci--; // closer still has length: look for another opener
  }
}

function renderNodes(nodes) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (typeof nd === 'string') { out += escapeText(nd); continue; }
    switch (nd.t) {
      case 'code':
        out += '<code>' + escapeEncode(nd.s) + '</code>';
        break;
      case 'delim': {
        // Normally a leftover literal follows the close tags
        // (cm-446). When litFirst is set (a closer run right after
        // an inner em close), the leftover belongs inside, before
        // the close tags (doc-11/30).
        if (nd.litFirst && nd.len > 0) out += nd.ch.repeat(nd.len);
        for (let q = 0; q < nd.closes.length; q++) out += nd.closes[q] === 'strong' ? '</strong>' : '</em>';
        if (!nd.litFirst && nd.len > 0) out += nd.ch.repeat(nd.len);
        for (let q = nd.opens.length - 1; q >= 0; q--) out += nd.opens[q] === 'strong' ? '<strong>' : '<em>';
        break;
      }
      case 'bracket':
        out += nd.image ? '![' : '[';
        break;
      case 'link':
        out += '<a href="' + escapeText(nd.href) + '"' + (nd.title !== null ? ' title="' + escapeText(nd.title) + '"' : '') + '>';
        break;
      case 'linkClose':
        out += '</a>';
        break;
      case 'image': {
        const alt = renderPlainText(nodes, nd.start, nd.end);
        out += '<img src="' + escapeText(nd.href) + '" alt="' + escapeText(alt) + '"' +
          (nd.title !== null ? ' title="' + escapeText(nd.title) + '"' : '') + '>';
        // Skip the inner nodes (consumed into alt) and the dead node.
        k = nd.end;
        break;
      }
      case 'html':
        out += nd.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'soft':
        out += '\n';
        break;
      case 'raw':
        out += nd.s;
        break;
      case 'autolink':
        out += '<a href="' + escapeText(nd.href) + '">' + escapeText(nd.text) + '</a>';
        break;
      default:
        break;
    }
  }
  return out;
}

// A link label must match the label grammar: a sequence of plain text,
// nested [...] and code spans. A span is a matching-runs span (open and
// close runs of the same length, content may hold backticks) or, failing
// that, a run span (open run, backtick-free content, close run of any
// length). Once a span whose content holds a backtick has been seen, the
// rest of the label may hold only whitespace and matching-runs spans of
// two or more backticks (a lone single backtick at the very end is
// allowed); plain text, nested brackets, single-backtick spans and run
// spans fail it. A second backtick-holding span lifts the restriction
// again (the count is even). A backtick run with no matching close
// fails, except a lone single backtick at the very end in the
// restricted state. Shortcut links are exempt (their label is a
// reference name, not link text).
// Returns {valid, reason}: reason is 'innerTick' when the failure is
// the restricted-state rule (that failure also kills emphasis inside
// the label), 'lone' for a lone backtick run, 'other' otherwise.
function checkLabelGrammar(label) {
  let i = 0;
  const n = label.length;
  let innerTicks = 0;
  let hasRunSpan = false;
  let depth = 0;
  while (i < n) {
    const c = label[i];
    if (c === '\\' && i + 1 < n && isPunct(label[i + 1])) { i += 2; continue; }
    if (c === '[') {
      if (innerTicks % 2 === 1) return { valid: false, reason: 'innerTick' };
      depth++;
      i++;
      continue;
    }
    if (c === ']') {
      if (depth === 0) return { valid: false, reason: 'other' };
      depth--;
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && label[j] === '`') j++;
      const len = j - i;
      // First try a matching-runs span (open and close runs of the
      // same length; its content may hold backticks).
      let close = -1;
      let p = j;
      while (p < n) {
        if (label[p] === '`') {
          let q = p;
          while (q < n && label[q] === '`') q++;
          if (q - p === len) { close = p; break; }
          p = q;
        } else p++;
      }
      if (close >= 0) {
        if (innerTicks % 2 === 1 && len < 2) return { valid: false, reason: 'innerTick' };
        if (label.slice(j, close).indexOf('`') !== -1) innerTicks++;
        i = close + len;
        continue;
      }
      // Fallback: a run span (open run, backtick-free content, close
      // run of any length). These never hold a backtick, and are not
      // allowed at all in the restricted state.
      let k = j;
      while (k < n && label[k] !== '`') k++;
      if (k < n) {
        if (innerTicks % 2 === 1) return { valid: false, reason: 'innerTick' };
        let q = k;
        while (q < n && label[q] === '`') q++;
        hasRunSpan = true;
        i = q;
        continue;
      }
      if (innerTicks % 2 === 1 && len === 1 && j === n) return { valid: true, reason: 'ok', hasRunSpan };
      return { valid: false, reason: 'lone' };
    }
    if (innerTicks % 2 === 1 && c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') {
      return { valid: false, reason: 'innerTick' };
    }
    i++;
  }
  return { valid: true, reason: 'ok', hasRunSpan };
}

// Parse one inline string into HTML. refs: Map of normalized label ->
// {dest, title}. out (optional) is filled with {hasLink} when a real
// link forms, so a caller that embeds this HTML (strikethrough) can
// tell the outer link check that a link hides inside it.
function inlineToHtml(s, refs, out) {
  // Fast path: nothing that can form a construct.
  if (!INLINE_SLOW.test(s)) return escapeText(s);

  const nodes = [];
  const delims = [];
  const brackets = [];
  // Delimiter-index ranges [start, end) inside link/image text: emphasis
  // may not cross a link boundary.
  const linkRanges = [];
  // Source ends of inline links/images whose label holds a run span
  // (a mismatched backtick run), and source starts of code spans:
  // together they suppress later _ / ** emphasis (see processEmphasis).
  const triggers = [];
  const codeSpans = [];
  let i = 0;
  const n = s.length;
  let textBuf = '';
  let textStart = 0;
  const flushText = () => { if (textBuf) { nodes.push(textBuf); textBuf = ''; } };

  // Record a tentative (bare) autolink in `out` when a caller embeds
  // this HTML (strikethrough): the outer link check needs to strip it
  // back to plain text if the enclosing [...] forms a link (doc-34).
  // Angle autolinks are not tentative, so they are never recorded.
  const noteTentative = (href, text) => {
    if (out) {
      if (!out.tentativeAutolinks) out.tentativeAutolinks = [];
      out.tentativeAutolinks.push({ href, text });
    }
  };

  // The ']' that closes the innermost active bracket, scanning forward
  // from a position inside it (depth counts nested brackets; escapes
  // are skipped). Returns -1 when the bracket never closes.
  function findBracketClosePos(from) {
    let depth = 0;
    let p = from;
    while (p < n) {
      const ch = s[p];
      if (ch === '\\' && p + 1 < n) { p += 2; continue; }
      if (ch === '[') { depth++; p++; continue; }
      if (ch === ']') {
        if (depth === 0) return p;
        depth--;
        p++;
        continue;
      }
      p++;
    }
    return -1;
  }

  // Would the bracket br form a link/image if its ']' were at closePos?
  // Replicates the ']' handler's decision using the nodes formed so far
  // (an inner link that forms later is not visible yet).
  function wouldBracketForm(br, closePos) {
    let href = null;
    let inlineParsed = false;
    let isFullRef = false;
    let inlineFailed = false;
    if (s[closePos + 1] === '(') {
      const tail = parseInlineLinkTail(s, closePos + 1);
      if (tail) { href = cleanUrl(tail.dest); inlineParsed = true; }
      else inlineFailed = true;
    }
    if (href === null && (inlineFailed || s[closePos + 1] !== '(')) {
      let label = null;
      if (s[closePos + 1] === '[') {
        let j = closePos + 2;
        while (j < n && s[j] !== ']') j++;
        if (j < n) { label = s.slice(closePos + 2, j); isFullRef = true; }
      }
      if (label === null) label = s.slice(br.srcPos, closePos);
      else if (label === '') label = s.slice(br.srcPos, closePos);
      const norm = normalizeLabel(label);
      if (norm && refs.has(norm)) href = cleanUrl(refs.get(norm).dest);
    }
    if (href === null) return false;
    if (!inlineParsed && !isFullRef) return true;
    if (!checkLabelGrammar(s.slice(br.srcPos, closePos)).valid) return false;
    if (!br.image) {
      for (let k = br.node + 1; k < nodes.length; k++) {
        const nd = nodes[k];
        if (typeof nd !== 'string' && nd.t === 'link') return false;
      }
    }
    return true;
  }

  // The innermost active bracket, if any.
  function innermostBracket() {
    for (let b = brackets.length - 1; b >= 0; b--) {
      if (brackets[b].active) return brackets[b];
    }
    return null;
  }

  while (i < n) {
    const found = findNext(s, i, refs.suppressAutolink);
    if (!found) { textBuf += s.slice(i); break; }
    const pos = found.pos;
    if (pos > i) { textBuf += s.slice(i, pos); i = pos; }

    if (found.kind === 'www' || found.kind === 'scheme') {
      // A bare autolink inside link/image text is tentative: if the
      // enclosing [...] forms a link/image it becomes plain text (a
      // link's text may not contain a bare autolink); if the bracket
      // fails, the autolink stands.
      const a = matchExtendedAutolink(s, i, refs.suppressAutolink);
      if (a) {
        // A bare autolink must not swallow the ']' that closes an
        // enclosing bracket which will form a link (the link wins over
        // the autolink); truncate it before that ']' instead.
        const innermost = innermostBracket();
        if (innermost) {
          const closePos = findBracketClosePos(i);
          if (closePos >= 0 && closePos < a.end && wouldBracketForm(innermost, closePos)) {
            const raw = s.slice(i, closePos);
            const isWww = raw.startsWith('www.');
            const text = backpedalUrl(raw);
            const colonAt = text.indexOf(':');
            if (text.length > 0 && (isWww || (colonAt >= 0 && colonAt < text.length - 1))) {
              const href = isWww
                ? (cleanUrl('http://' + text) || ('http://' + text))
                : (cleanUrl(text) || text);
              flushText();
              nodes.push({ t: 'autolink', href, text, tentative: true });
              noteTentative(href, text);
              i = i + text.length;
              textStart = i;
              continue;
            }
            textBuf += s[i];
            i++;
            continue;
          }
        }
        flushText();
        nodes.push({ t: 'autolink', href: a.href, text: a.text, tentative: true });
        noteTentative(a.href, a.text);
        i = a.end;
        textStart = i;
        continue;
      }
      // False alarm (should not happen: findNext validated it).
      textBuf += s[i];
      i++;
      continue;
    }

    const c = s[i];

    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flushText();
        nodes.push({ t: 'br' });
        i += 2;
        // After a hard break, leading spaces/tabs at the start of the
        // next line are stripped.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) {
        // An escaped & must render as &amp; even when followed by
        // entity-like text (an escaped & is a literal &, never an entity).
        if (nx === '&') {
          flushText();
          nodes.push({ t: 'raw', s: '&amp;' });
          i += 2;
          textStart = i;
          continue;
        }
        textBuf += nx;
        i += 2;
        continue;
      }
      textBuf += '\\';
      i++;
      continue;
    }

    if (c === '`') {
      // Count the backtick run.
      let j = i;
      while (j < n && s[j] === '`') j++;
      const len = j - i;
      // Find a closing run of exactly the same length. A span opened
      // inside a link/image label may only close before that label's
      // ']' when the label forms a link (the label is tokenized on its
      // own); when the bracket fails, the span may pair across the ']'
      // (cm-342/525/537). So a close found past the bracket's ']' is
      // used only if the bracket will not form a link.
      let close = -1;
      let p = j;
      while (p < n) {
        if (s[p] === '`') {
          let q = p;
          while (q < n && s[q] === '`') q++;
          if (q - p === len) { close = p; break; }
          p = q;
        } else p++;
      }
      if (close >= 0) {
        const innermost = innermostBracket();
        if (innermost) {
          const closePos = findBracketClosePos(i);
          if (closePos >= 0 && close > closePos && wouldBracketForm(innermost, closePos)) close = -1;
        }
      }
      if (close < 0) {
        textBuf += s.slice(i, j);
        i = j;
        continue;
      }
      let content = s.slice(j, close);
      content = content.replace(/\r\n|\r|\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          content.trim().length > 0) {
        content = content.slice(1, -1);
      }
      flushText();
      nodes.push({ t: 'code', s: content });
      codeSpans.push(i);
      i = close + len;
      textStart = i;
      continue;
    }

    if (c === '<') {
      let done = false;
      AUTOLINK_RE.lastIndex = i;
      let m = AUTOLINK_RE.exec(s);
      if (m) {
        flushText();
        nodes.push({ t: 'autolink', href: cleanUrl(m[1]) || m[1], text: m[1] });
        i = AUTOLINK_RE.lastIndex;
        textStart = i;
        done = true;
      } else {
        EMAIL_AUTOLINK_RE.lastIndex = i;
        m = EMAIL_AUTOLINK_RE.exec(s);
        if (m) {
          flushText();
          nodes.push({ t: 'autolink', href: 'mailto:' + m[1], text: m[1] });
          i = EMAIL_AUTOLINK_RE.lastIndex;
          textStart = i;
          done = true;
        } else {
          const hlen = matchHtmlTag(s, i);
          if (hlen > 0) {
            flushText();
            const tag = s.slice(i, i + hlen);
            nodes.push({ t: 'html', s: tag });
            // Bare-autolink suppression is a toggle on the <a> tag
            // (doc-30/doc-03/doc-06): an <a ...> opening tag with at
            // least one attribute (a bare <a> does not count) turns
            // suppression ON, and a </a> tag turns it OFF again
            // (ba01-ba04: a complete <a>...</a> pair, or a </a> in a
            // later paragraph, re-enables bare autolinks — even one
            // after the </a> in the same paragraph). While ON, no
            // bare URL/email autolink forms anywhere later in the
            // document; explicit [text](url) links and <...> autolinks
            // are unaffected. A </a> that is an HTML block (alone on
            // a line) never reaches inline parsing, so it does not
            // clear the flag (aw02).
            if (/^<a\s+[^>\s]/i.test(tag)) {
              refs.suppressAutolink = true;
            } else if (/^<\/a\s*>/i.test(tag)) {
              refs.suppressAutolink = false;
            }
            i += hlen;
            textStart = i;
            done = true;
          }
        }
      }
      if (done) continue;
      textBuf += '<';
      i++;
      continue;
    }

    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      flushText();
      const br = { t: 'bracket', image, active: true, srcPos: i + (image ? 2 : 1), delimStart: delims.length };
      nodes.push(br);
      br.node = nodes.length - 1;
      brackets.push(br);
      i += image ? 2 : 1;
      textStart = i;
      continue;
    }

    if (c === ']') {
      // Most recent active bracket.
      let bi = -1;
      for (let b = brackets.length - 1; b >= 0; b--) {
        if (brackets[b].active) { bi = b; break; }
      }
      if (bi < 0) { textBuf += ']'; i++; continue; }
      const br = brackets[bi];
      let href = null;
      let title = null;
      let end = i + 1;
      let inlineFailed = false;
      let inlineParsed = false;
      let isFullRef = false;

      if (s[i + 1] === '(') {
        const tail = parseInlineLinkTail(s, i + 1);
        if (tail) {
          href = cleanUrl(tail.dest);
          title = tail.title;
          end = tail.end;
          inlineParsed = true;
        } else {
          inlineFailed = true;
        }
      }
      // Fall through to reference/shortcut only if the inline link did
      // not parse at all (a parsed-but-uncleanable URL does not fall back).
      if (href === null && (inlineFailed || s[i + 1] !== '(')) {
        let label = null;
        let labelEnd = i + 1;
        if (s[i + 1] === '[') {
          let j = i + 2;
          while (j < n && s[j] !== ']') j++;
          if (j < n) { label = s.slice(i + 2, j); labelEnd = j + 1; isFullRef = true; }
        }
        if (label === null) {
          label = s.slice(br.srcPos, i);
          labelEnd = i + 1;
        } else if (label === '') {
          label = s.slice(br.srcPos, i);
        }
        const norm = normalizeLabel(label);
        if (norm && refs.has(norm)) {
          const ref = refs.get(norm);
          href = cleanUrl(ref.dest);
          title = ref.title;
          end = labelEnd;
        }
      }

      if (href === null) {
        br.active = false;
        textBuf += ']';
        i++;
        continue;
      }
      // A link label must match the label grammar (inline links and
      // full reference links; shortcut links are exempt). A failed
      // label forms no link, and when the failure is the restricted
      // backtick-span rule of a parsed inline tail, emphasis inside
      // the label is dead too.
      let labelHasRunSpan = false;
      if (!inlineParsed && !isFullRef) {
        // Shortcut link: no grammar check.
      } else {
        const g = checkLabelGrammar(s.slice(br.srcPos, i));
        labelHasRunSpan = !!g.hasRunSpan;
        if (!g.valid) {
          if (inlineParsed && g.reason === 'innerTick') {
            for (let d = 0; d < delims.length; d++) {
              const dm = delims[d];
              if (!dm.active || dm.pos === undefined) continue;
              if (dm.pos < br.srcPos || dm.pos >= i) continue;
              let inside = false;
              for (let r = 0; r < linkRanges.length; r++) {
                if (d >= linkRanges[r][0] && d < linkRanges[r][1]) { inside = true; break; }
              }
              if (!inside) dm.active = false;
            }
          }
          br.active = false;
          textBuf += ']';
          i++;
          continue;
        }
      }
      // A link's text may not contain another link (an image's may).
      // An autolink (<...> or bare) inside the text does NOT block the
      // outer link: the reference still forms it (nested <a>), so only
      // a real link node blocks.
      if (!br.image) {
        let hasLink = false;
        for (let k = br.node + 1; k < nodes.length; k++) {
          const nd = nodes[k];
          if (typeof nd !== 'string' && nd.t === 'link') { hasLink = true; break; }
          // A link can hide inside a strikethrough node, whose inner
          // content was parsed recursively (doc-05): the raw node
          // records whether a link formed inside it.
          if (typeof nd !== 'string' && nd.t === 'raw' && nd.hasLink) { hasLink = true; break; }
        }
        if (hasLink) {
          br.active = false;
          textBuf += ']';
          i++;
          continue;
        }
      }
      flushText();
      const startNode = br.node + 1;
      const endNode = nodes.length;
      // Bare autolinks inside this link/image text become plain text.
      for (let k = startNode; k < endNode; k++) {
        const nd = nodes[k];
        if (typeof nd !== 'string' && nd.t === 'autolink' && nd.tentative) nodes[k] = nd.text;
        else if (typeof nd !== 'string' && nd.t === 'raw' && nd.tentativeAutolinks) {
          // A strikethrough node's inner HTML may hold tentative
          // (bare) autolinks: strip each back to its plain text
          // (doc-34). The anchor is rendered as <a href="H">T</a>
          // with both parts escaped, so rebuild that exact string
          // and replace it with the escaped text. Angle autolinks
          // are not tentative, so they are left alone.
          let html = nd.s;
          for (const ta of nd.tentativeAutolinks) {
            const anchor = '<a href="' + escapeText(ta.href) + '">' + escapeText(ta.text) + '</a>';
            const at = html.indexOf(anchor);
            if (at >= 0) html = html.slice(0, at) + escapeText(ta.text) + html.slice(at + anchor.length);
          }
          nd.s = html;
        }
      }
      // Delimiters inside this link/image text form a boundary.
      if (delims.length > br.delimStart) linkRanges.push([br.delimStart, delims.length]);
      if (br.image) {
        nodes[br.node] = { t: 'image', href, title, start: startNode, end: endNode };
        nodes.push({ t: 'dead' });
      } else {
        nodes[br.node] = { t: 'link', href, title, start: startNode, end: endNode };
        nodes.push({ t: 'linkClose' });
        if (out) out.hasLink = true;
      }
      // An inline link/image whose label holds a run span is a trigger
      // for the emphasis suppression in processEmphasis (reference
      // and shortcut links are not).
      if (inlineParsed && labelHasRunSpan) triggers.push(end);
      for (let b = 0; b < brackets.length; b++) {
        if (brackets[b].node >= br.node && brackets[b].node < nodes.length) brackets[b].active = false;
      }
      i = end;
      textStart = i;
      continue;
    }

    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const len = j - i;
      const prev = i > 0 ? s[i - 1] : undefined;
      const next = j < n ? s[j] : undefined;
      // The start/end of the string count as whitespace for flanking.
      const prevIsSpace = prev === undefined || isSpace(prev);
      const nextIsSpace = next === undefined || isSpace(next);
      const prevIsPunct = isUnicodePunct(prev);
      const nextIsPunct = isUnicodePunct(next);
      const leftFlanking = !nextIsSpace && (!nextIsPunct || prevIsSpace || prevIsPunct);
      const rightFlanking = !prevIsSpace && (!prevIsPunct || nextIsSpace || nextIsPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
      else {
        canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
        canClose = rightFlanking && (!leftFlanking || isPunct(next));
      }
      // A run that can neither open nor close emphasis is literal text.
      // (This also keeps an intraword "_" inside a potential email local
      // part from splitting the pending text.)
      if (!canOpen && !canClose) {
        textBuf += s.slice(i, j);
        i = j;
        continue;
      }
      flushText();
      const d = { t: 'delim', ch: c, len, canOpen, canClose, active: true, opens: [], closes: [], pos: i };
      nodes.push(d);
      delims.push(d);
      i = j;
      textStart = i;
      continue;
    }

    if (c === '~') {
      if (i > 0 && s[i - 1] === '~') { textBuf += '~'; i++; continue; }
      const dm = matchDel(s, i);
      if (dm) {
        // Capture the match end BEFORE recursing: the recursive
        // inlineToHtml call reuses DEL_RE and clobbers its lastIndex.
        const endPos = dm.end;
        const innerOut = {};
        const innerHtml = inlineToHtml(dm.content, refs, innerOut);
        flushText();
        // Keep the tentative (bare) autolinks the inner parse recorded:
        // if an enclosing [...] forms a link, they are stripped back
        // to plain text inside the <del> (doc-34). Angle autolinks
        // are not tentative, so they stay as links.
        nodes.push({ t: 'raw', s: '<del>' + innerHtml + '</del>', hasLink: !!innerOut.hasLink, tentativeAutolinks: innerOut.tentativeAutolinks || null });
        if (innerOut.hasLink && out) out.hasLink = true;
        i = endPos;
        textStart = i;
        continue;
      }
      let j = i;
      while (j < n && s[j] === '~') j++;
      textBuf += s.slice(i, j);
      i = j;
      continue;
    }

    if (c === '\n') {
      let k = textBuf.length;
      while (k > 0 && textBuf[k - 1] === ' ') k--;
      const trailing = textBuf.length - k;
      if (trailing >= 2) {
        textBuf = textBuf.slice(0, k);
        flushText();
        nodes.push({ t: 'br' });
        i++;
        // After a hard break, leading spaces/tabs at the start of the
        // next line are stripped.
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        textStart = i;
      } else {
        flushText();
        nodes.push({ t: 'soft' });
        i++;
        textStart = i;
      }
      continue;
    }

    if (c === '@') {
      // Suppressed after an unclosed <a> tag (see above): a bare
      // email is a bare autolink, so it stays plain text.
      if (refs.suppressAutolink) { textBuf += '@'; i++; continue; }
      // A bare email inside link/image text is tentative, like a bare
      // URL (see the www/scheme handler): it becomes plain text if the
      // enclosing [...] forms a link/image, and stands if it fails.
      // (Angle <...> autolinks are still created inside brackets,
      // and they do not block the outer link — see the hasLink check.)
      // Email autolink: the local part is the tail of the pending text
      // (textBuf already has escapes resolved, so scanning back there
      // is escape-aware); the domain is matched in the source after @.
      // This avoids mapping textBuf offsets back to source positions,
      // which drifts when an escape collapsed two source chars into one.
      let j = textBuf.length;
      while (j > 0 && EMAIL_LOCAL.test(textBuf[j - 1])) j--;
      if (j < textBuf.length) {
        const local = textBuf.slice(j);
        // The local part's source span must hold no backslash escape:
        // an escaped char inside it (foo\+@bar) invalidates the bare
        // email. Walk back in the source over the local part's chars,
        // counting an escape (backslash + local char) as one char.
        let srcPos = i - 1;
        let counted = 0;
        let hasEscape = false;
        while (counted < local.length && srcPos >= textStart) {
          const ch = s[srcPos];
          if (ch === '\\' && srcPos + 1 < i && EMAIL_LOCAL.test(s[srcPos + 1])) {
            // An escape: backslash + char is one text char, so it does
            // not add to the count, but it invalidates the email.
            hasEscape = true;
            srcPos--;
          } else if (EMAIL_LOCAL.test(ch)) {
            counted++;
            srcPos--;
          } else break;
        }
        if (hasEscape || counted < local.length) {
          textBuf += '@';
          i++;
          continue;
        }
        // A preceding scheme (mailto:/xmpp:) extends the autolink.
        let start = j;
        let scheme = null;
        if (j > 0 && textBuf[j - 1] === ':') {
          let k = j - 2;
          while (k >= 0 && /[a-zA-Z0-9+.\-]/.test(textBuf[k])) k--;
          const sc = textBuf.slice(k + 1, j - 1);
          if (sc.length >= 2 && sc.length <= 32 && /^[a-zA-Z]/.test(sc) &&
              (k < 0 || !/[a-zA-Z0-9+.\-]/.test(textBuf[k]))) {
            scheme = sc;
            start = k + 1;
          }
        }
        // Domain after @ in the source.
        DOMAIN_RE.lastIndex = i + 1;
        const dm = DOMAIN_RE.exec(s);
        if (dm) {
          const domainEnd = i + 1 + dm[0].length;
          // A trailing - or _ after the domain invalidates it only when
          // it continues a word or trails the text (gfm-632:
          // a.b-c_d@a.b_ at end of input). When followed by whitespace
          // or punctuation it is an emphasis delimiter or punctuation
          // (doc-31/34/37/38: ...com_ write), so the email still links.
          // A _ that starts an emphasis run (foo@bar.com__) is also a
          // delimiter: the next char is _ (identifier-like) but the pair
          // is a delimiter, so it does not invalidate either.
          const after = s[domainEnd];
          if (after === '-' || after === '_') {
            const after2 = s[domainEnd + 1];
            const continuesWord = after2 !== undefined &&
              after2 !== '_' && /[a-zA-Z0-9_\-.]/.test(after2);
            const atEnd = after2 === undefined;
            if (continuesWord || atEnd) {
              textBuf += '@';
              i++;
              continue;
            }
          }
          const email = local + '@' + dm[0];
          let href, text;
          if (scheme) {
            if (scheme.toLowerCase() === 'mailto') {
              href = 'mailto:' + email;
              text = 'mailto:' + email;
            } else {
              href = scheme + ':' + email;
              text = scheme + ':' + email;
            }
          } else {
            href = 'mailto:' + email;
            text = email;
          }
          textBuf = textBuf.slice(0, start);
          flushText();
          nodes.push({ t: 'autolink', href, text, tentative: true });
          noteTentative(href, text);
          i = domainEnd;
          textStart = i;
          continue;
        }
      }
      textBuf += '@';
      i++;
      continue;
    }

    // Should not be reached (findNext only stops on the handled kinds).
    textBuf += c;
    i++;
  }

  flushText();
  processEmphasis(delims, linkRanges, triggers, codeSpans);
  return renderNodes(nodes);
}

// ===================== Block parsing =====================

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Number of leading whitespace columns (a tab advances to the next
// multiple of 4).
function indentCols(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return col;
}

// Remove the first n columns of leading whitespace from a line.
// A tab that straddles the boundary contributes its remaining columns
// as spaces.
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const next = col + (4 - (col % 4));
      if (next <= n) { col = next; i++; }
      else return ' '.repeat(next - n) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// Remove up to n leading columns from a fenced code block content
// line. Unlike stripCols, a tab that straddles the boundary is removed
// entirely (no remainder spaces): the tab is a single character and
// the reference drops it whole (ae01/ae04/ae05: a tab at column 0 in a
// fence indented 1-3 leaves 0 spaces, while 4 spaces leave 4-n).
function stripFenceCols(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const next = col + (4 - (col % 4));
      if (next <= n) { col = next; i++; }
      else { i++; break; }
    } else break;
  }
  return line.slice(i);
}

// Expand every tab in a line to spaces, based on the tab's column
// (a tab advances to the next multiple of 4).
function expandAllTabs(line) {
  if (line.indexOf('\t') < 0) return line;
  let col = 0;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// If the line starts a blockquote, return the content after '>' plus one
// optional following space. Tabs are expanded by column in the
// indent-removed line (not the original line): a tab right after '> '
// sits at column 2 and expands to 2 spaces (doc-05/08/09/14/19/40),
// while a tab after '>   ' keeps its column-4 expansion (doc-02).
// If the content after '> ' starts a nested blockquote, strip by
// characters so the inner level sees the tab itself (doc-05:
// `> > \tindented` -> inner `> \tindented` -> 2 spaces).
function blockquotePrefix(line) {
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  if (rest[0] !== '>') return null;
  if (rest.length === 1) return '';
  const after = rest[1] === ' ' ? rest.slice(2) : rest.slice(1);
  let k = 0;
  while (k < after.length && k < 3 && after[k] === ' ') k++;
  if (after[k] === '>') return after;
  const expanded = expandAllTabs(rest);
  if (expanded[1] === ' ') return expanded.slice(2);
  return expanded.slice(1);
}

// Number of characters of leading whitespace (spaces/tabs) in the line.
function indentChars(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

const ATX_RE = /^#{1,6}(?:[ \t]|$)/;
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const THEMATIC_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

const HTML_BLOCK_TYPE1 = /^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i;
const HTML_BLOCK_TYPE2 = /^ {0,3}<!--/;
const HTML_BLOCK_TYPE3 = /^ {0,3}<\?/;
const HTML_BLOCK_TYPE4 = /^ {0,3}<![A-Za-z]/;
const HTML_BLOCK_TYPE5 = /^ {0,3}<!\[CDATA\[/;
const HTML_BLOCK_TYPE6 = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s>\/]|$)/i;
const HTML_TAG_ONLY_RE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;

// HTML block start type (1-6, or 7). types16Only: only types 1-6
// (type 7 cannot interrupt a paragraph).
function htmlBlockType(line, types16Only) {
  if (HTML_BLOCK_TYPE1.test(line)) return 1;
  if (HTML_BLOCK_TYPE2.test(line)) return 2;
  if (HTML_BLOCK_TYPE3.test(line)) return 3;
  if (HTML_BLOCK_TYPE4.test(line)) return 4;
  if (HTML_BLOCK_TYPE5.test(line)) return 5;
  if (HTML_BLOCK_TYPE6.test(line)) return 6;
  if (!types16Only && HTML_TAG_ONLY_RE.test(line)) return 7;
  return 0;
}

function htmlBlockEnd(line, type) {
  if (type === 1) return /<\/(script|pre|style|textarea)/i.test(line);
  if (type === 2) return line.indexOf('-->') >= 0;
  if (type === 3) return line.indexOf('?>') >= 0;
  if (type === 4) return line.indexOf('>') >= 0;
  if (type === 5) return line.indexOf(']]>') >= 0;
  return false; // types 6-7 end at a blank line
}

// Parse a list marker at the start of `rest` (the line after its leading
// spaces). Returns null or {ordered, bullet, delim, number, markerLen}.
function parseListMarker(rest) {
  const c = rest[0];
  if (c === '-' || c === '+' || c === '*') {
    if (rest.length === 1 || rest[1] === ' ' || rest[1] === '\t') {
      return { ordered: false, bullet: c, delim: null, number: 0, markerLen: 1 };
    }
    return null;
  }
  if (c >= '0' && c <= '9') {
    let j = 0;
    while (j < rest.length && rest[j] >= '0' && rest[j] <= '9') j++;
    if (j > 9) return null;
    if (j < rest.length && (rest[j] === '.' || rest[j] === ')') &&
        (j + 1 === rest.length || rest[j + 1] === ' ' || rest[j + 1] === '\t')) {
      return { ordered: true, bullet: null, delim: rest[j], number: parseInt(rest.slice(0, j), 10), markerLen: j + 1 };
    }
  }
  return null;
}

// Whether a line (content, leading spaces already allowed) starts a new
// block that would interrupt a paragraph or end a table.
// Whether an indent-stripped line opens a fenced code block. A ```
// fence's info string may not contain a backtick (so "```inner
// backticks```" is a code span, not a fence opener).
function isFenceStart(rest) {
  const m = FENCE_RE.exec(rest);
  if (!m) return false;
  if (m[1][0] === '`' && m[2].includes('`')) return false;
  return true;
}

function isBlockStart(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = stripCols(line, ind);
  if (ATX_RE.test(rest)) return true;
  if (isFenceStart(rest)) return true;
  if (htmlBlockType(rest, true) > 0) return true;
  if (THEMATIC_RE.test(rest)) return true;
  if (rest[0] === '>') return true;
  if (parseListMarker(rest)) return true;
  return false;
}

// Whether a line interrupts a paragraph (list rules: bullet always,
// ordered only from 1 — but only at the top level: inside a container
// (list item, blockquote) any ordered marker interrupts, matching the
// reference, which starts a nested list after a paragraph there).
function interruptsParagraph(line, nested) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = stripCols(line, ind);
  if (ATX_RE.test(rest)) return true;
  if (isFenceStart(rest)) return true;
  if (htmlBlockType(rest, true) > 0) return true;
  if (THEMATIC_RE.test(rest)) return true;
  if (rest[0] === '>') return true;
  const lm = parseListMarker(rest);
  if (lm) {
    // An empty list item cannot interrupt a paragraph.
    if (rest.slice(lm.markerLen).trim() === '') return false;
    if (!lm.ordered) return true;
    if (nested || lm.number === 1) return true;
  }
  return false;
}

// Skip spaces/tabs (same line only).
function skipSpacesTabs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// Skip spaces, tabs and newlines.
function skipSpaceNewlines(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Try to parse a link reference definition from the paragraph lines
// starting at index idx. Returns null or {normLabel, dest, title, nextLine}.
function tryParseRefDef(lines, idx) {
  const text = lines.slice(idx).join('\n');
  let p = 0;
  while (p < text.length && text[p] === ' ') p++;
  if (p > 3 || text[p] !== '[') return null;
  const labelEnd = findLabelEnd(text, p);
  if (labelEnd < 0) return null;
  const label = text.slice(p + 1, labelEnd);
  const norm = normalizeLabel(label);
  if (!norm) return null;
  let q = skipSpaceNewlines(text, labelEnd + 1);
  if (text[q] !== ':') return null;
  q++;
  q = skipSpaceNewlines(text, q);
  const dest = parseLinkDestination(text, q);
  if (dest === null) return null;
  q = dest.end;
  let title = null;
  let r = skipSpacesTabs(text, q);
  if (r < text.length && text[r] === '\n') {
    // The title may be on the next line. If it is malformed (or followed
    // by junk), the definition still stands without a title.
    let r2 = r + 1;
    while (r2 < text.length && (text[r2] === ' ' || text[r2] === '\t')) r2++;
    if (r2 < text.length && (text[r2] === '"' || text[r2] === "'" || text[r2] === '(')) {
      const t = parseLinkTitle(text, r2);
      if (t !== null) {
        const r3 = skipSpacesTabs(text, t.end);
        if (r3 >= text.length || text[r3] === '\n') {
          title = t.title;
          r = r3;
        }
      }
    }
  } else if (r > q && r < text.length && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
    // Title on the same line: requires whitespace after the destination.
    const t = parseLinkTitle(text, r);
    if (t === null) return null;
    title = t.title;
    r = skipSpacesTabs(text, t.end);
    if (r < text.length && text[r] !== '\n') return null;
  } else if (r < text.length) {
    return null;
  }
  const endPos = r < text.length ? r + 1 : r;
  // A reference definition may not contain a blank line.
  if (/\n[ \t]*\n/.test(text.slice(0, endPos))) return null;
  // Lines spanned = internal newlines before the ref-def end + 1.
  let linesConsumed = 1;
  for (let k = 0; k < r; k++) if (text[k] === '\n') linesConsumed++;
  return { normLabel: norm, dest: dest.dest, title, nextLine: idx + linesConsumed };
}

// Split a table row line into cells (unescaped | separators; optional
// leading/trailing | do not create empty cells).
function splitTableCells(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Skip a leading pipe.
  let start = 0;
  while (start < n && line[start] === ' ') start++;
  if (line[start] === '|') start++;
  for (i = start; i < n; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // Drop a trailing empty cell from a trailing pipe.
  let end = n - 1;
  while (end >= start && line[end] === ' ') end--;
  if (line[end] === '|' && cells.length > 1) cells.pop();
  return cells;
}

// Parse a table delimiter row. Returns the alignments array
// ('left'|'center'|'right'|null per column) or null.
function parseTableDelimiter(line) {
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    const m = /^(:?)-+(:?)$/.exec(t);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[2] === ':') aligns.push('right');
    else if (m[1] === ':') aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

// Render a table block. headerCells/delimiter/rows are arrays of cell strings.
function renderTable(headerCells, aligns, rows, refs) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    const a = aligns[c];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineToHtml(headerCells[c].trim(), refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      out += '<tr>\n';
      for (let c = 0; c < headerCells.length; c++) {
        const cell = c < row.length ? row[c].trim() : '';
        const a = aligns[c];
        out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineToHtml(cell, refs) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return out;
}

// Strip leading/trailing pipes from a table row line for the header check.
function tableRowCells(line) {
  return splitTableCells(line);
}

// Parse a block range into block objects.
// Each block: {t:'para', inline} (inline HTML, no <p> wrapper) or
// {t:'html', s} (complete HTML, ending with \n).
// Returns {blocks, next, loose}: loose is true when two top-level blocks
// in this range were separated by a blank line.
function parseBlocks(lines, start, end, refs, collectOnly, isTop, srcEndsWithNl) {
  const blocks = [];
  let i = start;
  let loose = false;
  let sawBlank = false;
  let hadBlock = false;

  const addBlock = (b) => {
    if (sawBlank && hadBlock) loose = true;
    blocks.push(b);
    hadBlock = true;
    sawBlank = false;
  };

  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    const ind = indentCols(line);
    const rest = ind <= 3 ? stripCols(line, ind) : line;

    // ATX heading
    if (ind <= 3 && ATX_RE.test(rest)) {
      const level = rest.match(/^#+/)[0].length;
      let content = rest.slice(level);
      // Closing sequence: spaces + #s + optional spaces at the end.
      const cm = content.match(/^(.*?)[ \t]+#+[ \t]*$/);
      if (cm) content = cm[1];
      else if (/^[ \t]*#+[ \t]*$/.test(content)) content = '';
      content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (!collectOnly) {
        addBlock({ t: 'html', s: '<h' + level + '>' + inlineToHtml(content, refs) + '</h' + level + '>\n' });
      } else { addBlock({ t: 'html', s: '' }); }
      i++;
      continue;
    }

    // Fenced code
    if (ind <= 3) {
      const fm = FENCE_RE.exec(rest);
      if (fm && (fm[1][0] !== '`' || fm[2].indexOf('`') < 0)) {
        const fenceChar = fm[1][0];
        const fenceLen = fm[1].length;
        const info = fm[2].trim().replace(/\\([!-/:-@\[-`{-~])/g, '$1');
        const lang = info ? info.split(/\s+/)[0] : '';
        const contentLines = [];
        let j = i + 1;
        let closed = false;
        while (j < end) {
          const l = lines[j];
          const li = indentCols(l);
          const lr = li <= 3 ? stripCols(l, li) : l;
          const closeRe = new RegExp('^\\' + fenceChar + '{' + fenceLen + ',}[ \\t]*$');
          if (li <= 3 && closeRe.test(lr)) { closed = true; j++; break; }
          // Remove up to `ind` leading columns — but only for a ```
          // fence. A ~~~ fence does not strip its indent from content
          // lines at all (the reference keeps the full indentation,
          // ah01/ah03/ai01-ai06/aj01/aj04); a ``` fence strips up to
          // `ind` columns. A tab straddling the boundary is dropped
          // whole (stripFenceCols), not left as remainder spaces.
          contentLines.push(fenceChar === '~' ? l : stripFenceCols(l, ind));
          j++;
        }
        if (!collectOnly) {
          let code = contentLines.join('\n');
          if (code.length && code[code.length - 1] !== '\n') code += '\n';
          addBlock({ t: 'html', s: '<pre><code' + (lang ? ' class="language-' + escapeText(lang) + '"' : '') + '>' + escapeEncode(code) + '</code></pre>\n' });
        } else { addBlock({ t: 'html', s: '' }); }
        i = j;
        continue;
      }
    }

    // HTML block
    if (ind <= 3) {
      const htype = htmlBlockType(rest, false);
      if (htype > 0) {
        const htmlLines = [line];
        let j = i + 1;
        if (htype <= 5) {
          // If the first line already contains the end condition
          // (e.g. <style>...</style> or <!-- ... --> on one line),
          // the block is just that line.
          if (!htmlBlockEnd(line, htype)) {
            while (j < end) {
              htmlLines.push(lines[j]);
              if (htmlBlockEnd(lines[j], htype)) { j++; break; }
              j++;
            }
          }
        } else {
          while (j < end && !isBlankLine(lines[j])) { htmlLines.push(lines[j]); j++; }
        }
        if (!collectOnly) {
          let s = htmlLines.join('\n');
          // A trailing newline unless the immediately following line is
          // blank. For types 1-5 the block ends at its end condition,
          // so only a truly empty next line suppresses the newline —
          // a whitespace-only line (spaces or tab) does not (doc-19:
          // 3 spaces after --> still gets the trailing \n; doc-24:
          // 3 spaces after </pre> likewise; doc-15: a tab-only line
          // after --> likewise; cm-148/cm-308 with a truly empty
          // next line do not). For types 6-7 the block ends because
          // of the blank line itself, so any blank line (including
          // tab-only) suppresses it (doc-03: a tab line after </p>
          // gives </p><p> with no newline).
          // At the end of the lines array, only append it at the top
          // level and only when the source itself ends with a newline.
          const nextBlank = j < end && (htype >= 6 ? isBlankLine(lines[j]) : lines[j].length === 0);
          if ((j < end && !nextBlank) || (j >= end && isTop && srcEndsWithNl)) s += '\n';
          addBlock({ t: 'html', s });
        } else addBlock({ t: 'html', s: '' });
        i = j;
        continue;
      }
    }

    // Thematic break
    if (ind <= 3 && THEMATIC_RE.test(rest)) {
      if (!collectOnly) addBlock({ t: 'html', s: '<hr>\n' });
      else addBlock({ t: 'html', s: '' });
      i++;
      continue;
    }

    // Blockquote
    if (ind <= 3 && rest[0] === '>') {
      const content = [];
      let j = i;
      let prevParaLine = false;
      // Fence state inside this blockquote: a lazy line cannot continue
      // a fenced code block (lazy continuation is paragraph-only).
      const fst = { ch: null, len: 0, prev: false };
      while (j < end) {
        const l = lines[j];
        const c = blockquotePrefix(l);
        if (c !== null) {
          // A whitespace-only (but non-empty) content line after a
          // paragraph line is a paragraph continuation: the spaces are
          // preserved as part of the paragraph text.
          if (fst.prev && c.length > 0 && c.trim() === '') {
            content[content.length - 1] += '\n' + c;
            j++;
          } else {
            content.push(c);
            // Track fenced code blocks: their content lines are not
            // paragraph lines, so a following lazy line ends the quote.
            prevParaLine = trackFence(c, fst);
            j++;
          }
        } else if (!isBlankLine(l) && prevParaLine && !isBlockStart(l)) {
          // Lazy continuation line (must not start a new block).
          // Append it to the previous paragraph line so the inner parser
          // cannot treat it as a new block start (e.g. a "- bar" marker).
          // Leading whitespace is stripped by 4 columns only when the
          // line is indented 4 or more columns (as for an indented code
          // block): 1-3 spaces are kept (doc-25: lazy ` fn main()`
          // keeps its space, from a tab straddling the list indent),
          // 4 columns are removed entirely and 5 leave one space
          // (cm-238: `    - bar` -> `- bar`).
          // A lazy setext underline (===) must not form a heading:
          // indent it to 4 spaces so the setext pattern cannot match
          // (the reference renders it with 4 spaces).
          const stripped4 = indentCols(l) >= 4 ? stripCols(l, 4) : l;
          const fullyStripped = l.replace(/^[ \t]+/, '');
          const add = /^=+[ \t]*$/.test(fullyStripped) ? '    ' + fullyStripped : stripped4;
          content[content.length - 1] += '\n' + add;
          j++;
        } else break;
      }
      const inner = parseBlocks(content, 0, content.length, refs, collectOnly, false, srcEndsWithNl);
      if (!collectOnly) {
        let s = '<blockquote>\n';
        for (const b of inner.blocks) s += renderBlock(b, refs);
        s += '</blockquote>\n';
        addBlock({ t: 'html', s });
      } else addBlock({ t: 'html', s: '' });
      i = j;
      continue;
    }

    // List
    if (ind <= 3) {
      const lm = parseListMarker(rest);
      if (lm) {
        const res = parseList(lines, i, end, refs, collectOnly, srcEndsWithNl);
        if (!collectOnly) addBlock({ t: 'html', s: res.html });
        else addBlock({ t: 'html', s: '' });
        i = res.next;
        continue;
      }
    }

    // Indented code (only at a block boundary)
    if (ind >= 4) {
      const codeLines = [];
      let j = i;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) {
          // A blank line belongs to the code block only if a following
          // indented line continues it. Its content is the line with
          // 4 columns stripped (so trailing whitespace is preserved).
          let k = j + 1;
          while (k < end && isBlankLine(lines[k])) k++;
          if (k < end && indentCols(lines[k]) >= 4) {
            while (j < k) { codeLines.push(stripCols(lines[j], 4)); j++; }
            continue;
          }
          break;
        }
        if (indentCols(l) < 4) break;
        codeLines.push(stripCols(l, 4));
        j++;
      }
      // Remove trailing blank lines.
      while (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      if (!collectOnly) {
        const code = codeLines.length ? codeLines.join('\n') + '\n' : '';
        addBlock({ t: 'html', s: '<pre><code>' + escapeEncode(code) + '</code></pre>\n' });
      } else addBlock({ t: 'html', s: '' });
      i = j;
      continue;
    }

    // Paragraph (with setext heading, table, ref-def stripping).
    // Paragraph lines keep their leading whitespace entirely.
    {
      const paraLines = [line];
      let j = i + 1;
      let setextLevel = 0;
      let table = null;
      while (j < end) {
        const l = lines[j];
        if (isBlankLine(l)) break;
        const sm = SETEXT_RE.exec(l);
        if (sm) { setextLevel = sm[1][0] === '=' ? 1 : 2; j++; break; }
        if (interruptsParagraph(l, !isTop)) break;
        paraLines.push(l);
        j++;
      }
      // Table check: first line has a delimiter row as the second line.
      if (setextLevel === 0 && paraLines.length >= 1 && j < end + 1) {
        // The delimiter row is the line right after the first paragraph line,
        // which we have not yet consumed if it is a delimiter row.
        // We need the raw next line: it is lines[j] only when the paragraph
        // loop stopped because of it. Re-check using the paragraph lines
        // themselves when the delimiter was consumed as a continuation line.
        // Simpler: if the second paragraph line is a delimiter row, treat
        // the paragraph as a table.
        if (paraLines.length >= 2 && indentCols(paraLines[1]) <= 3) {
          const aligns = parseTableDelimiter(paraLines[1]);
          if (aligns !== null) {
            const headerCells = tableRowCells(paraLines[0]);
            if (headerCells.length === aligns.length) {
              const rows = [];
              let k = 2;
              // Consume further table rows from the paragraph lines.
              while (k < paraLines.length) {
                rows.push(tableRowCells(paraLines[k]));
                k++;
              }
              // Continue consuming rows from the following lines. A
              // whitespace-only line (spaces/tabs, but not truly empty)
              // is an empty row when the table continues after it; a
              // truly empty line ends the table. A line with | is a row.
              // A line without | is a row only when it is a single line
              // (next is blank, a block start, or end) or the next line
              // is a | row; otherwise it starts a paragraph instead.
              while (j < end) {
                const l = lines[j];
                if (isBlankLine(l)) {
                  if (l.length === 0) break;
                  let k = j + 1;
                  while (k < end && isBlankLine(lines[k])) k++;
                  // If the next line starts a NEW table (it is followed
                  // by a delimiter row), the current table ends here;
                  // the new table's header/delimiter must not be
                  // swallowed as rows of this table (doc-19).
                  if (k < end && !isBlockStart(lines[k]) &&
                      k + 1 < end && indentCols(lines[k + 1]) <= 3) {
                    const nkAligns = parseTableDelimiter(lines[k + 1]);
                    if (nkAligns !== null) {
                      const nkHeader = tableRowCells(lines[k]);
                      if (nkHeader.length === nkAligns.length) break;
                    }
                  }
                  // A tab-only line is an empty row and the table
                  // continues to the next content line (doc-26:
                  // "Foo *bar*" and "=========" after the tab line
                  // are rows, not a paragraph/heading). A spaces-only
                  // line ends the table outright (ar01/ar02/ar05,
                  // doc-29): it is a blank separator, not an empty
                  // row — even when a | row or a paragraph follows,
                  // the table does not continue past it.
                  const isTabLine = l.indexOf('\t') !== -1;
                  if (!isTabLine) break;
                  if (k >= end || isBlockStart(lines[k])) {
                    rows.push(new Array(aligns.length).fill(''));
                    break;
                  }
                  rows.push(new Array(aligns.length).fill(''));
                  j = k;
                  continue;
                }
                if (isBlockStart(l)) break;
                // A line without | is a table row when it is part of
                // the table block (doc-26: "Foo *bar*" and
                // "=========" after an empty row are rows, not a
                // paragraph/heading). The table ends at a blank
                // line or a block start, handled above.
                rows.push(tableRowCells(l));
                j++;
              }
              table = { headerCells, aligns, rows };
            }
          }
        }
      }
      if (table) {
        if (!collectOnly) addBlock({ t: 'html', s: renderTable(table.headerCells, table.aligns, table.rows, refs) });
        else addBlock({ t: 'html', s: '' });
        i = j;
        continue;
      }
      if (setextLevel > 0) {
        // Strip ref defs first (a setext heading cannot be a ref def, but
        // the paragraph lines before it might start with ref defs).
        const rem = stripRefDefsFromLines(paraLines, refs);
        const text = rem.join('\n').trim();
        if (text !== '') {
          if (!collectOnly) {
            addBlock({ t: 'html', s: '<h' + setextLevel + '>' + inlineToHtml(text, refs) + '</h' + setextLevel + '>\n' });
          } else { addBlock({ t: 'html', s: '' }); }
          i = j;
          continue;
        }
        // The paragraph was only ref defs: the setext underline is not a
        // heading underline. Backtrack to it so it starts a new paragraph.
        i = j - 1;
        continue;
      }
      // Ordinary paragraph: strip leading ref defs.
      const rem = stripRefDefsFromLines(paraLines, refs);
      if (rem.length > 0) {
        const text = rem.join('\n');
        if (!collectOnly) addBlock({ t: 'para', inline: inlineToHtml(text, refs) });
        else addBlock({ t: 'html', s: '' });
      } else {
        // A paragraph of only ref defs renders nothing, but it is still
        // a block boundary for looseness (a blank line before it counts).
        if (sawBlank && hadBlock) loose = true;
        hadBlock = true;
        sawBlank = false;
      }
      i = j;
      continue;
    }
  }

  return { blocks, next: i, loose };
}

// Strip leading link reference definitions from paragraph lines.
// Returns the remaining lines.
function stripRefDefsFromLines(paraLines, refs) {
  let idx = 0;
  while (idx < paraLines.length) {
    const res = tryParseRefDef(paraLines, idx);
    if (!res) break;
    if (!refs.has(res.normLabel)) refs.set(res.normLabel, { dest: res.dest, title: res.title });
    idx = res.nextLine;
  }
  return paraLines.slice(idx);
}

// Render one block object to HTML (paragraphs wrapped in <p>).
function renderBlock(b, refs) {
  if (b.t === 'para') return '<p>' + b.inline + '</p>\n';
  return b.s;
}

// Parse a list starting at lines[i]. Returns {html, next}.
function parseList(lines, i, end, refs, collectOnly, srcEndsWithNl) {
  const firstLine = lines[i];
  const firstInd = indentCols(firstLine);
  const firstRest = stripCols(firstLine, firstInd);
  const firstMarker = parseListMarker(firstRest);
  const isOrdered = firstMarker.ordered;
  const bullet = firstMarker.bullet;
  const delim = firstMarker.delim;

  // Content indent of the first item.
  const contentIndent = listContentIndent(firstLine, firstInd, firstMarker);
  const items = [];
  let loose = false;
  let j = i;
  // Content indent of the previous item; a new item is a sibling when its
  // marker indent is below it (a dedented item with the same marker is
  // still a sibling, not a new list).
  let prevContentIndent = Infinity;
  while (j < end) {
    const line = lines[j];
    const ind = indentCols(line);
    if (ind > 3) break;
    const rest = stripCols(line, ind);
    // A thematic break ends the list; it is not a list item.
    if (THEMATIC_RE.test(rest)) break;
    const lm = parseListMarker(rest);
    if (!lm) break;
    if (lm.ordered !== isOrdered) break;
    if (!isOrdered && lm.bullet !== bullet) break;
    if (isOrdered && lm.delim !== delim) break;
    if (ind >= prevContentIndent) break;
    const ci = listContentIndent(line, ind, lm);
    const item = collectListItem(lines, j, end, ci, ind, lm);
    items.push(item);
    // Looseness is decided by the item's own parsed blocks (inner.loose
    // below), not by blank lines seen while collecting: those may belong
    // to a nested list, not to this item.
    prevContentIndent = ci;
    j = item.next;
    // Skip blank lines; if the next non-blank line is another item of
    // this list, continue (a blank line between items makes it loose).
    let k = j;
    while (k < end && isBlankLine(lines[k])) k++;
    if (k < end) {
      const nind = indentCols(lines[k]);
      // A following item must start at indent 0-3 (as in the main
      // loop above): an indented line such as `    1. nested` is an
      // indented code block, not the next item — treating it as one
      // wrongly marks the list loose (aq01/aq02/aq04/aq05, doc-22).
      if (nind <= 3 && nind < prevContentIndent) {
        const nrest = stripCols(lines[k], nind);
        if (!THEMATIC_RE.test(nrest)) {
          const nlm = parseListMarker(nrest);
          if (nlm && nlm.ordered === isOrdered &&
              (isOrdered ? nlm.delim === delim : nlm.bullet === bullet)) {
            if (k > j) loose = true;
            j = k;
            continue;
          }
        }
      }
    }
    j = item.next;
    break;
  }

  if (collectOnly) {
    // Still need to collect ref defs inside the items: parse each item's
    // content in collect mode.
    for (const item of items) {
      parseBlocks(item.content, 0, item.content.length, refs, true, false, srcEndsWithNl);
    }
    return { html: '', next: j };
  }

  // First pass: parse every item so the list's looseness is settled
  // before any item is rendered (a loose item makes the whole list loose,
  // including items before it).
  const inners = items.map(item => parseBlocks(item.content, 0, item.content.length, refs, false, false, srcEndsWithNl));
  for (const inner of inners) if (inner.loose) loose = true;

  let html = isOrdered
    ? '<ol' + (firstMarker.number !== 1 ? ' start="' + firstMarker.number + '"' : '') + '>\n'
    : '<ul>\n';
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const inner = inners[idx];
    const cb = item.task === null ? '' : (item.task
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ');
    // In a loose list the checkbox goes inside the first paragraph
    // (<li><p><input ...> text</p>); otherwise directly after <li>.
    const cbInPara = loose && inner.blocks.length > 0 && inner.blocks[0].t === 'para';
    let s = '<li>' + (cbInPara ? '' : cb);
    for (let bi = 0; bi < inner.blocks.length; bi++) {
      const b = inner.blocks[bi];
      if (b.t === 'para') {
        s += loose ? '<p>' + (bi === 0 && cbInPara ? cb : '') + b.inline + '</p>\n' : b.inline;
      } else {
        s += b.s;
      }
    }
    if (s.endsWith('\n')) s += '</li>\n';
    else s += '</li>\n';
    html += s;
  }
  html += isOrdered ? '</ol>\n' : '</ul>\n';
  return { html, next: j };
}

// Content indent (in columns) for a list item line.
function listContentIndent(line, indent, marker) {
  const markerLen = marker.markerLen;
  let col = indent + markerLen;
  let i = indentChars(line) + markerLen;
  let spaces = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { spaces++; col++; i++; }
    else {
      const next = col + (4 - (col % 4));
      spaces += next - col;
      col = next;
      i++;
    }
  }
  if (spaces === 0) return indent + markerLen + 1;
  if (spaces >= 5) return indent + markerLen + 1;
  // If nothing but whitespace follows the marker on this line, the item
  // starts empty: content indent is marker width + 1, not the full run.
  if (i >= line.length) return indent + markerLen + 1;
  return indent + markerLen + spaces;
}

// Content of a list item's first line: the marker and the whitespace
// after it, up to contentIndent columns, removed. Tabs are expanded to
// spaces (by original column) so the returned content's columns stay
// consistent.
function listItemFirstContent(line, indent, marker, contentIndent) {
  const expanded = expandAllTabs(line);
  const indExp = indentCols(expanded);
  const markerStart = indExp;
  const afterMarker = markerStart + marker.markerLen;
  if (afterMarker >= expanded.length) return '';
  if (contentIndent <= afterMarker) return expanded.slice(afterMarker);
  // Remove whitespace up to contentIndent columns.
  let i = afterMarker;
  let col = afterMarker;
  while (i < expanded.length && col < contentIndent && expanded[i] === ' ') {
    col++;
    i++;
  }
  return expanded.slice(i);
}

// Is this content line a paragraph line (so a following lazy line may
// continue it)? Looks through nested blockquote prefixes and list
// markers to the innermost content.
// Strip blockquote prefixes and list markers to the innermost content
// (a lazy line may continue a paragraph nested inside containers).
function innermostContent(c) {
  let inner = c;
  for (let guard = 0; guard < 20; guard++) {
    const before = inner.length;
    const p = blockquotePrefix(inner);
    if (p !== null) { inner = p; if (inner.length < before) continue; break; }
    const ind = indentCols(inner);
    if (ind > 3) break;
    const rest = stripCols(inner, ind);
    const lm = parseListMarker(rest);
    if (!lm) break;
    const ci = listContentIndent(inner, ind, lm);
    inner = listItemFirstContent(inner, ind, lm, ci);
    if (inner.length >= before) break;
  }
  return inner;
}

// A fence opener on a (container-stripped) line: {ch, len} or null.
// A ``` fence's info string may not contain a backtick.
function fenceOpen(line) {
  // Only a fence at this container level opens the fence state: do
  // NOT look through a nested blockquote (>) or list marker (a fence
  // inside a nested blockquote belongs to that blockquote, not to
  // this level — as01/doc-21: a `> > ```rust` must not leave the
  // outer blockquote "inside a fence", or a later lazy line cannot
  // continue its paragraph). The line is already stripped of this
  // container's own prefix, so a fence here starts with ``` / ~~~
  // directly (after up to 3 spaces of indent).
  const ind = indentCols(line);
  if (ind > 3) return null;
  const rest = stripCols(line, ind);
  const m = FENCE_RE.exec(rest);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length };
}

// Whether a (container-stripped) line closes a fence opened with ch/len.
function fenceClose(line, ch, len) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const rest = stripCols(line, ind);
  let k = 0;
  while (k < rest.length && rest[k] === ch) k++;
  if (k < len) return false;
  return rest.slice(k).trim() === '';
}

// Update fence tracking + paragraph-line state for a content line.
// st is {ch, len, prev} and is mutated in place. Returns the new
// prevParaLine. While inside a fence, no line is a paragraph line, so a
// following lazy line ends the container instead of continuing it.
function trackFence(c, st) {
  if (st.ch) {
    if (fenceClose(c, st.ch, st.len)) st.ch = null;
    st.prev = false;
  } else {
    const fo = fenceOpen(c);
    if (fo) { st.ch = fo.ch; st.len = fo.len; st.prev = false; }
    else st.prev = isParaLine(c, st.prev);
  }
  return st.prev;
}

function isParaLine(c, prevPara) {
  const inner = innermostContent(c);
  if (isBlankLine(inner)) return false;
  if (isBlockStart(inner)) return false;
  if (indentCols(inner) >= 4 && !prevPara) return false;
  return true;
}

// Expand the leading tabs of `s` (which starts at column `col`) to
// spaces, stopping at the first non-whitespace character. A tab's width
// depends on its column, so the column is tracked as we go.
function expandLeadingTabs(s, col) {
  let i = 0;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; col++; i++; }
    else if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
      i++;
    } else break;
  }
  return out + s.slice(i);
}

// Strip a list item's content indent from the raw line. Leading tabs
// are expanded by their column (starting at contentIndent), so a tab
// keeps its width across nested list strips (doc-01: a tab at column 13
// -> 3 spaces, not 2). Expansion stops at the first non-whitespace
// character, so a tab after a '>' marker is left for the blockquote
// handling (marked: `> \tindented` -> 2 spaces, not 4).
function stripListContent(line, contentIndent) {
  const stripped = stripCols(line, contentIndent);
  return expandLeadingTabs(stripped, contentIndent);
}

// Collect one list item's content lines (content indent stripped).
// Returns {content, next, hadBlankBetween, task}.
function collectListItem(lines, i, end, contentIndent, markerIndent, firstMarker) {
  const content = [];
  // First line's content.
  const firstLine = lines[i];
  content.push(listItemFirstContent(firstLine, markerIndent, firstMarker, contentIndent));
  let j = i + 1;
  // Fence state: a lazy line cannot continue a fenced code block.
  const fst = { ch: null, len: 0, prev: false };
  // content.length when the current fence opened (-1 when no fence is
  // open). An under-indented line ends the item only while the fence
  // is still empty (doc-17/38); once content lines exist the fence
  // keeps absorbing under-indented lines (doc-02).
  let fenceOpenLen = -1;
  function noteFence(c) {
    const wasOpen = fst.ch !== null;
    const p = trackFence(c, fst);
    if (!wasOpen && fst.ch !== null) fenceOpenLen = content.length;
    if (wasOpen && fst.ch === null) fenceOpenLen = -1;
    return p;
  }
  let prevParaLine = noteFence(content[0]);
  let hadBlankBetween = false;
  let blanksSinceBlock = 0;
  while (j < end) {
    const line = lines[j];
    // Inside a fenced code block, every line is fence content — even
    // one indented less than the item's content indent, and even a
    // blank line — until the closing fence. But a non-blank line
    // indented below the item's content indent ends the item while
    // the fence is still empty (it is not a lazy continuation:
    // fences have none), so the fence ends empty (doc-17: ```toml
    // followed by an unindented line; doc-38: ```bash likewise).
    // Once fence content exists, under-indented lines are absorbed
    // as fence content (doc-02). A closing fence line is always
    // absorbed even when under-indented.
    if (fst.ch) {
      if (isBlankLine(line)) {
        content.push('');
        j++;
        continue;
      }
      const c0 = stripListContent(line, contentIndent);
      if (indentCols(line) < contentIndent && !fenceClose(c0, fst.ch, fst.len) &&
          content.length === fenceOpenLen) {
        break;
      }
      content.push(c0);
      prevParaLine = noteFence(c0);
      j++;
      continue;
    }
    if (isBlankLine(line)) {
      // An item with no content yet ends at a blank line (an empty item
      // cannot absorb lines after the blank).
      let hasContent = false;
      for (const c of content) if (!isBlankLine(c)) { hasContent = true; break; }
      if (!hasContent) break;
      // Look ahead: does the item continue after this blank line?
      let k = j + 1;
      while (k < end && isBlankLine(lines[k])) k++;
      if (k >= end) break;
      const nline = lines[k];
      const nind = indentCols(nline);
      if (nind >= contentIndent) {
        content.push('');
        blanksSinceBlock++;
        j++;
        continue;
      }
      if (nind === markerIndent) {
        const nlm = parseListMarker(stripCols(nline, nind));
        if (nlm && nlm.ordered === firstMarker.ordered &&
            (firstMarker.ordered ? nlm.delim === firstMarker.delim : nlm.bullet === firstMarker.bullet)) {
          break; // blank line between items: the item ends here
        }
      }
      if (prevParaLine && !isBlankLine(nline) && !isBlockStart(nline)) {
        // A lazy continuation after a blank line is not a continuation.
        break;
      }
      break;
    }
    const ind = indentCols(line);
    if (ind >= contentIndent) {
      if (blanksSinceBlock > 0) hadBlankBetween = true;
      blanksSinceBlock = 0;
      // Strip the content indent from the raw line (tabs are expanded
      // by their own column, not the original column).
      const c = stripListContent(line, contentIndent);
      content.push(c);
      prevParaLine = noteFence(c);
      j++;
      continue;
    }
    if (ind === markerIndent) {
      const r = stripCols(line, ind);
      if (THEMATIC_RE.test(r)) break; // a thematic break ends the item
      const lm = parseListMarker(r);
      if (lm) break; // a new item (same or different list) ends this one
    }
    if (prevParaLine && !isBlockStart(line)) {
      // Lazy continuation line: strip leading whitespace up to the
      // item's content indent (but no more than the line's own indent).
      // A lazy line that falls short of the content indent by exactly
      // one keeps its spaces as paragraph text (doc-22: 3 spaces vs
      // content indent 4; doc-26: 2 vs 3; doc-06: 1 space), unless it
      // starts with a list marker: then the indent is stripped so the
      // marker becomes literal text, not a nested item (cm-312:
      // "    - e" vs content indent 5 becomes "- e"). A line short
      // by two or more is structural and stripped (cm-291: a
      // 4-space lazy line vs content indent 6 loses its indent).
      // Append it to the previous content line so the inner parser
      // cannot treat it as a new block start (e.g. a "- e" marker).
      // The rule is purely about the line's own indent: strip 4
      // columns when it is indented 4 or more, keep all of it
      // otherwise (ak06/al01/al04/am01/am04: li=1 keeps 1, li=4
      // strips to 0, li=5 strips 4 leaving 1, li=6 strips 4 leaving
      // 2 — marker and non-marker lines alike; cm-291/cm-312).
      if (blanksSinceBlock > 0) hadBlankBetween = true;
      blanksSinceBlock = 0;
      const li = indentCols(line);
      const strip = li >= 4 ? 4 : 0;
      content[content.length - 1] += '\n' + stripCols(line, strip);
      prevParaLine = !isBlockStart(line);
      j++;
      continue;
    }
    break;
  }
  while (content.length && isBlankLine(content[content.length - 1])) content.pop();
  // Task list: the item's first line starts with [ ] / [x] / [X].
  let task = null;
  if (content.length) {
    const m = content[0].match(/^\[([ xX])\] /);
    if (m) {
      task = m[1] === 'x' || m[1] === 'X';
      content[0] = content[0].slice(4);
    }
  }
  return { content, next: j, hadBlankBetween, task };
}

// ===================== Entry point =====================

export function parse(markdown) {
  // Skip the \r\n normalisation when there is no \r at all (the
  // common case): the regex replace would copy the whole document
  // for nothing.
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const srcEndsWithNl = src.endsWith('\n');
  const lines = src.split('\n');
  // A trailing newline produces one artifact empty line; drop it so it
  // is not mistaken for a real blank line (which would make lists loose).
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  // Document-level bare-autolink suppression (see inlineToHtml): set
  // when an unclosed <a ...> inline tag is seen. It is reset before
  // the render pass so pass 1 (ref collection) cannot leak it in.
  refs.suppressAutolink = false;
  // Pass 1: collect link reference definitions. A ref def is
  // "[label]: dest", so it always contains "]:". If the source has no
  // "]:", there can be no ref defs and pass 1 is skipped entirely —
  // this avoids a full second block parse for the large majority of
  // documents (speed: the common case is a single render pass).
  if (src.indexOf(']:') !== -1) {
    parseBlocks(lines, 0, lines.length, refs, true, true, srcEndsWithNl);
  }
  refs.suppressAutolink = false;
  // Pass 2: render.
  const res = parseBlocks(lines, 0, lines.length, refs, false, true, srcEndsWithNl);
  let out = '';
  for (const b of res.blocks) out += renderBlock(b, refs);
  return out;
}
