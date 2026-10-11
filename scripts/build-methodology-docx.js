// Builds the unbranded Word edition of the methodology reference.
//
//   NODE_PATH=$(npm root -g) node scripts/build-methodology-docx.js [out.docx]
//
// The text comes from DATA-METHODOLOGY.md, parsed at build time. This script
// used to carry its own hand-copied version of the text, which fell weeks
// behind the markdown (stale station counts, missing sections), so the
// markdown is now the only copy and this file decides presentation alone.
// The parser covers exactly the markdown that file uses — headings, paragraphs,
// tables, bullet and numbered lists, fenced code, one-line blockquotes, rules,
// **bold**, *italic* and `code` — and stops with an error on anything it
// would otherwise drop or mis-render, rather than produce a quietly wrong
// document. The output is a working document: .docx is gitignored and must
// never be committed (see .gitignore).
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  TableOfContents, PageBreak, LevelFormat,
} = require('docx');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'DATA-METHODOLOGY.md');
const OUT = process.argv[2] || path.join(__dirname, '..', 'Bali-Air-Dispatch-Data-Methodology.docx');

// ── page geometry (A4, 2cm margins) ───────────────────────────────────
const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1134;
const TW = 9600;                       // usable table width (DXA)

const SERIF = 'Cambria';               // headings
const SANS  = 'Calibri';               // body
const MONO  = 'Consolas';

const INK    = '1A1A1A';
const SOFT   = '444444';
const FAINT  = '6B6B6B';
const RULE   = 'BFBFBF';
const HEADBG = 'EDEDED';
const CALLBG = 'F4F4F4';
const ACCENT = '7A1F1F';

// ── helpers ───────────────────────────────────────────────────────────
// A run is a [text, {bold, italics, code}] pair, as produced by inline().
const textRun = (r, base) => new TextRun({
  text: r[0],
  font: r[1].code ? MONO : (base.font || SANS),
  size: r[1].code ? Math.max(base.size - 2, 16) : base.size,
  color: base.color,
  bold: Boolean(base.bold || r[1].bold),
  italics: Boolean(base.italics || r[1].italics),
});

// rich paragraph
const RP = (runs, opts = {}) => {
  const base = { size: opts.size || 20, color: opts.color || INK, italics: opts.italics };
  return new Paragraph({
    spacing: { before: opts.before ?? 0, after: opts.after ?? 120, line: opts.line ?? 276 },
    children: runs.map(r => textRun(r, base)),
  });
};

const heading = (level, size, color, before, after) => (t) => new Paragraph({
  heading: level,
  spacing: { before, after },
  children: [new TextRun({ text: t, font: SERIF, size, bold: true, color })],
});
const H1 = heading(HeadingLevel.HEADING_1, 30, INK, 380, 160);
const H2 = heading(HeadingLevel.HEADING_2, 24, INK, 280, 120);

const BULLET = (runs) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  spacing: { after: 90, line: 276 },
  children: runs.map(r => textRun(r, { size: 20, color: INK })),
});
// `instance` restarts the count, so each numbered list in the source starts at 1.
const NUM = (runs, instance) => new Paragraph({
  numbering: { reference: 'numbers', level: 0, instance },
  spacing: { after: 110, line: 276 },
  children: runs.map(r => textRun(r, { size: 20, color: INK })),
});

// callout: shaded block with a left accent border
const CALLOUT = (runs) => new Paragraph({
  spacing: { before: 160, after: 160, line: 276 },
  indent: { left: 220, right: 220 },
  shading: { type: ShadingType.CLEAR, fill: CALLBG, color: 'auto' },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 10 } },
  children: runs.map(r => textRun(r, { size: 20, color: SOFT })),
});

const CODE = (line) => new Paragraph({
  spacing: { after: 20, line: 240 },
  indent: { left: 260 },
  // A blank code line still needs a run, or Word collapses it.
  children: [new TextRun({ text: line || ' ', font: MONO, size: 17, color: SOFT })],
});

const cell = (runs, w, o = {}) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: o.head ? { type: ShadingType.CLEAR, fill: HEADBG, color: 'auto' } : undefined,
  margins: { top: 70, bottom: 70, left: 110, right: 110 },
  children: [new Paragraph({
    spacing: { after: 0, line: 252 },
    children: runs.map(r => textRun(r, {
      size: o.head ? 17 : 18,
      bold: o.head,
      color: o.head ? INK : SOFT,
    })),
  })],
});

// header is null for the markdown key/value tables, whose header row is empty.
const TABLE = (widths, header, rows) => new Table({
  columnWidths: widths,
  width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: RULE },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    left:   { style: BorderStyle.SINGLE, size: 4, color: RULE },
    right:  { style: BorderStyle.SINGLE, size: 4, color: RULE },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: RULE },
  },
  rows: [
    ...(header ? [new TableRow({
      tableHeader: true,
      children: header.map((h, i) => cell(h, widths[i], { head: true })),
    })] : []),
    ...rows.map(r => new TableRow({
      children: r.map((c, i) => cell(c, widths[i], {})),
    })),
  ],
});

const SPACER = (h = 120) => new Paragraph({ spacing: { after: h }, children: [] });
const HR = () => new Paragraph({
  spacing: { before: 160, after: 160 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
  children: [],
});

// ── inline markdown ───────────────────────────────────────────────────
// Straight quotes become typographic ones outside code: an opening quote
// follows a space, an opening bracket or a dash, or starts the text.
const curly = (s, prev) => s.replace(/['"]/g, (q, i) => {
  const before = i > 0 ? s[i - 1] : prev;
  const opens = !before || /[\s(\[—–-]/.test(before);
  if (q === "'") return opens ? '‘' : '’';
  return opens ? '“' : '”';
});

// Splits a line into runs on **bold**, *italic* and `code`. Markers toggle,
// so bold and italic nest either way round. An unclosed marker is a typo in
// the source that would otherwise run to the end of the paragraph, so it
// stops the build instead.
function inline(text, where) {
  const runs = [];
  let bold = false, italics = false, buf = '', last = '';
  const flush = (code = false) => {
    if (!buf) return;
    const t = code ? buf : curly(buf, last);
    runs.push([t, { bold, italics, code }]);
    last = t[t.length - 1];
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close < 0) throw new Error(`unclosed \` in ${where}: ${text}`);
      flush();
      buf = text.slice(i + 1, close);
      flush(true);
      i = close;
    } else if (c === '*' && text[i + 1] === '*') {
      flush(); bold = !bold; i++;
    } else if (c === '*') {
      flush(); italics = !italics;
    } else {
      buf += c;
    }
  }
  flush();
  if (bold || italics) throw new Error(`unclosed ${bold ? '**' : '*'} in ${where}: ${text}`);
  return runs;
}

const plain = (runs) => runs.map(r => r[0]).join('');

// ── tables ────────────────────────────────────────────────────────────
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());

// Column widths follow the text each column holds: a blend of its longest and
// its average cell, clamped so a short label column stays readable and a long
// prose column cannot squeeze the others to nothing.
function columnWidths(rows) {
  const n = rows[0].length;
  const weight = [];
  for (let c = 0; c < n; c++) {
    const lens = rows.map(r => (r[c] || '').length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    weight.push(Math.min(Math.max(0.5 * avg + 0.5 * Math.max(...lens), 10), 120));
  }
  // Every column gets a floor; the rest of the width is shared by weight.
  const FLOOR = 1100;
  const sum = weight.reduce((a, b) => a + b, 0);
  const spare = TW - FLOOR * n;
  const widths = weight.map(w => FLOOR + Math.floor(spare * w / sum));
  widths[n - 1] += TW - widths.reduce((a, b) => a + b, 0);
  return widths;
}

// ── document body ─────────────────────────────────────────────────────
const lines = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n').split('\n');
const body = [];
let i = 0;
const at = () => `${path.basename(SOURCE)}:${i + 1}`;
const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };

// Title block: "# Kicker — Title", the "###" subtitle under it, and the
// italic note before the first rule.
skipBlank();
const titleMatch = /^# (.+)$/.exec(lines[i]);
if (!titleMatch) throw new Error(`${at()}: expected the "# " title`);
const [kicker, title] = titleMatch[1].includes(' — ') ? titleMatch[1].split(' — ') : ['', titleMatch[1]];
i++; skipBlank();
let subtitle = '';
if (/^### /.test(lines[i])) { subtitle = lines[i].slice(4).trim(); i++; skipBlank(); }
const note = [];
while (i < lines.length && lines[i].trim() !== '---') { if (lines[i].trim()) note.push(lines[i].trim()); i++; }
i++;

body.push(new Paragraph({ spacing: { before: 1900, after: 0 }, children: [] }));
if (kicker) body.push(new Paragraph({
  spacing: { after: 60 },
  children: [new TextRun({ text: kicker.toUpperCase(), font: SANS, size: 20, bold: true, color: FAINT, characterSpacing: 60 })],
}));
body.push(new Paragraph({
  spacing: { after: 140 },
  children: [new TextRun({ text: title, font: SERIF, size: 52, bold: true, color: INK })],
}));
if (subtitle) body.push(new Paragraph({
  spacing: { after: 260 },
  children: [new TextRun({ text: curly(subtitle), font: SERIF, size: 24, italics: true, color: SOFT })],
}));
body.push(new Paragraph({
  spacing: { after: 0 },
  border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 10 } },
  children: [],
}));
if (note.length) body.push(RP(inline(note.join(' '), 'title note'), { before: 140, color: FAINT, size: 19 }));
body.push(new Paragraph({ children: [new PageBreak()] }));

body.push(new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: 'Contents', font: SERIF, size: 28, bold: true, color: INK })],
}));
body.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
body.push(new Paragraph({ children: [new PageBreak()] }));

// "## 3. Title" → "3.  Title", the two-space gap the earlier edition used;
// "### 3.1 Title" → "3.1  Title".
const sectionTitle = (t) => curly(t.replace(/^(\d+(?:\.\d+)*\.?)\s+/, '$1  '));

// Everything after the last rule (the closing colophon) is set small and faint.
const lastRule = lines.map(l => l.trim()).lastIndexOf('---');
let numberedLists = 0;

const isBlockStart = (l) => /^(#{1,6} |[-*] |\d+\. |\||```|> )/.test(l) || l.trim() === '---';

while (i < lines.length) {
  const line = lines[i];
  const t = line.trim();
  if (!t) { i++; continue; }

  if (t === '---') {
    if (i === lastRule) body.push(HR());
    i++; continue;
  }

  let m;
  if ((m = /^## (.+)$/.exec(line))) { body.push(H1(sectionTitle(m[1]))); i++; continue; }
  if ((m = /^### (.+)$/.exec(line))) { body.push(H2(sectionTitle(m[1]))); i++; continue; }
  if (/^#/.test(line)) throw new Error(`${at()}: unsupported heading level: ${line}`);

  if (t.startsWith('```')) {
    i++;
    while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(CODE(lines[i++].replace(/\s+$/, '')));
    if (i >= lines.length) throw new Error('unclosed ``` code block');
    i++;
    body.push(SPACER(140));
    continue;
  }

  if (t.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
    const [head, sep, ...data] = rows;
    if (!sep || !sep.every(s => /^:?-+:?$/.test(s))) throw new Error(`${at()}: table without a --- separator row`);
    if (data.some(r => r.length !== head.length)) throw new Error(`${at()}: table row with the wrong number of cells`);
    const where = `table above ${at()}`;
    const widths = columnWidths(head.every(h => !h) ? data : [head, ...data]);
    body.push(TABLE(
      widths,
      head.every(h => !h) ? null : head.map(h => inline(h, where)),
      data.map(r => r.map(c => inline(c, where))),
    ));
    body.push(SPACER(160));
    continue;
  }

  if (/^[-*] /.test(t)) {
    while (i < lines.length && /^[-*] /.test(lines[i].trim())) {
      body.push(BULLET(inline(lines[i].trim().slice(2), at())));
      i++;
    }
    continue;
  }

  if (/^\d+\. /.test(t)) {
    // A numbered list runs on across blank lines between its items (§9 spaces them).
    const instance = ++numberedLists;
    for (;;) {
      body.push(NUM(inline(lines[i].trim().replace(/^\d+\. /, ''), at()), instance));
      i++;
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && /^\d+\. /.test(lines[j].trim())) i = j; else break;
    }
    continue;
  }

  if (t.startsWith('> ')) {
    const quote = [];
    while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
    body.push(CALLOUT(inline(quote.join(' '), at())));
    continue;
  }

  // Paragraph: consecutive lines up to a blank line or the start of another block.
  const para = [];
  const start = at();
  while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++].trim());
  const runs = inline(para.join(' '), start);
  body.push(i > lastRule
    ? RP(runs, { color: FAINT, size: 18, after: 120 })
    : RP(runs));
}

// ── assemble ──────────────────────────────────────────────────────────
const doc = new Document({
  creator: kicker || title,
  title: titleMatch[1],
  description: plain(inline(subtitle || title, 'subtitle')),
  // Asks Word to fill in the table of contents on opening; without it the
  // contents page stays empty until the reader updates the field by hand.
  features: { updateFields: true },
  styles: {
    default: {
      document: { run: { font: SANS, size: 20, color: INK } },
    },
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 360, hanging: 220 } } },
        }],
      },
      {
        reference: 'numbers',
        levels: [{
          level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 400, hanging: 260 } } },
        }],
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      },
    },
    children: body,
  }],
});

Packer.toBuffer(doc).then(b => {
  fs.writeFileSync(OUT, b);
  console.log('written:', OUT, b.length, 'bytes');
});
