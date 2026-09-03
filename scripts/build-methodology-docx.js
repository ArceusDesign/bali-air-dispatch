const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  TableOfContents, PageBreak, LevelFormat, convertInchesToTwip
} = require('docx');
const fs = require('fs');

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
const P = (text, opts = {}) => new Paragraph({
  spacing: { before: opts.before ?? 0, after: opts.after ?? 120, line: opts.line ?? 276 },
  alignment: opts.align,
  indent: opts.indent,
  border: opts.border,
  children: [new TextRun({
    text, font: opts.font || SANS, size: opts.size || 20,
    color: opts.color || INK, bold: opts.bold, italics: opts.italics,
  })],
});

// rich paragraph from [text, {bold|italics|...}] pairs
const RP = (runs, opts = {}) => new Paragraph({
  spacing: { before: opts.before ?? 0, after: opts.after ?? 120, line: opts.line ?? 276 },
  alignment: opts.align,
  indent: opts.indent,
  shading: opts.shading,
  border: opts.border,
  children: runs.map(r => new TextRun({
    text: r[0],
    font: (r[1] && r[1].font) || opts.font || SANS,
    size: (r[1] && r[1].size) || opts.size || 20,
    color: (r[1] && r[1].color) || opts.color || INK,
    bold: Boolean(r[1] && r[1].bold), italics: Boolean(r[1] && r[1].italics),
  })),
});

const H1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 380, after: 160 },
  children: [new TextRun({ text: t, font: SERIF, size: 30, bold: true, color: INK })],
});
const H2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 120 },
  children: [new TextRun({ text: t, font: SERIF, size: 24, bold: true, color: INK })],
});
const H3 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 220, after: 100 },
  children: [new TextRun({ text: t, font: SERIF, size: 21, bold: true, color: SOFT })],
});

const BULLET = (runs) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  spacing: { after: 90, line: 276 },
  children: runs.map(r => new TextRun({
    text: r[0], font: SANS, size: 20, color: INK,
    bold: Boolean(r[1] && r[1].bold), italics: Boolean(r[1] && r[1].italics),
  })),
});
const NUM = (runs) => new Paragraph({
  numbering: { reference: 'numbers', level: 0 },
  spacing: { after: 110, line: 276 },
  children: runs.map(r => new TextRun({
    text: r[0], font: SANS, size: 20, color: INK,
    bold: Boolean(r[1] && r[1].bold), italics: Boolean(r[1] && r[1].italics),
  })),
});

// callout: shaded block with a left accent border
const CALLOUT = (runs) => new Paragraph({
  spacing: { before: 160, after: 160, line: 276 },
  indent: { left: 220, right: 220 },
  shading: { type: ShadingType.CLEAR, fill: CALLBG, color: 'auto' },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 10 } },
  children: runs.map(r => new TextRun({
    text: r[0], font: SANS, size: 20, color: SOFT,
    bold: Boolean(r[1] && r[1].bold), italics: Boolean(r[1] && r[1].italics),
  })),
});

const CODE = (line) => new Paragraph({
  spacing: { after: 20, line: 240 },
  indent: { left: 260 },
  children: [new TextRun({ text: line, font: MONO, size: 17, color: SOFT })],
});

// Cell content is either a plain string (one run) or an array of [text, opts]
// run-pairs (one paragraph, several runs). Nothing here needs multi-paragraph
// cells. Detecting the two cases explicitly matters: an array of run-pairs used
// to be walked as though it were a list of paragraphs, so a PAIR was treated as
// a list of runs and `x[1].bold` landed on the STRING — resolving to
// String.prototype.bold, a function, which Word rejects as a b/@val attribute.
const cell = (content, w, o = {}) => {
  const runs = typeof content === 'string' ? [[content, {}]] : content;
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: o.head ? { type: ShadingType.CLEAR, fill: HEADBG, color: 'auto' } : undefined,
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    children: [new Paragraph({
      spacing: { after: 0, line: 252 },
      alignment: o.align,
      children: runs.map(x => new TextRun({
        text: String(x[0]),
        font: (x[1] && x[1].font) || SANS,
        size: o.head ? 17 : 18,
        bold: o.head ? true : Boolean(x[1] && x[1].bold),
        italics: Boolean(x[1] && x[1].italics),
        color: o.head ? INK : ((x[1] && x[1].color) || SOFT),
      })),
    })],
  });
};

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
    new TableRow({
      tableHeader: true,
      children: header.map((h, i) => cell(h, widths[i], { head: true })),
    }),
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

// ── document body ─────────────────────────────────────────────────────
const body = [];

// Title block
body.push(new Paragraph({ spacing: { before: 1900, after: 0 }, children: [] }));
body.push(new Paragraph({
  spacing: { after: 60 },
  children: [new TextRun({ text: 'BALI AIR DISPATCH', font: SANS, size: 20, bold: true, color: FAINT, characterSpacing: 60 })],
}));
body.push(new Paragraph({
  spacing: { after: 140 },
  children: [new TextRun({ text: 'Data Sources and Methodology', font: SERIF, size: 52, bold: true, color: INK })],
}));
body.push(new Paragraph({
  spacing: { after: 260 },
  children: [new TextRun({
    text: 'A technical reference: what we collect, how often, what we correct, and what we do not claim',
    font: SERIF, size: 24, italics: true, color: SOFT,
  })],
}));
body.push(new Paragraph({
  spacing: { after: 0 },
  border: { top: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 10 } },
  children: [],
}));
body.push(RP([
  ['Prepared 3 September 2026. Describes the system as deployed on that date. ', { italics: true }],
  ['Every figure in this document is reproducible from the public API described in §10.', { italics: true }],
], { before: 140, color: FAINT, size: 19 }));

body.push(new Paragraph({ children: [new PageBreak()] }));

// TOC
body.push(new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text: 'Contents', font: SERIF, size: 28, bold: true, color: INK })],
}));
body.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
body.push(new Paragraph({ children: [new PageBreak()] }));

// 1
body.push(H1('1.  Purpose of this document'));
body.push(P('Bali Air Dispatch is a non-commercial public-interest archive of particulate-matter readings across Bali. It operates no sensors of its own. It aggregates eight independent monitoring networks into a single continuously-archived record, applies one published correction, and publishes the result openly.'));
body.push(P('This document is the technical reference for that process. It is written to be checked rather than trusted: every rule below is stated precisely enough to be independently verified against the open API, and the sections on limitations (§9) are as detailed as the sections on method.'));
body.push(P('Three things are worth stating at the outset, because they shape everything that follows:'));
body.push(BULLET([['We do not own any measurement in this archive. ', { bold: true }], ['Every reading originates from a third-party network and remains subject to that network’s own terms.']]));
body.push(BULLET([['Low-cost sensors are not reference-grade instruments. ', { bold: true }], ['Nothing here is offered as a substitute for a calibrated reference monitor.']]));
body.push(BULLET([['One methodological choice — humidity correction — changes the headline compliance figure by roughly 29 percentage points. ', { bold: true }], ['That finding is set out in full in §6, because any discussion of what the data shows has to begin with it.']]));

// 2
body.push(H1('2.  Summary'));
body.push(TABLE([3400, 6200], ['Item', 'Value'], [
  ['Networks ingested', '8 (AirGradient, IQAir, PurpleAir, AQICN/WAQI, Nafas, Smart Citizen, OpenAQ, Airly)'],
  ['Stations in catalogue', '78'],
  ['Stations reporting live', '39 (at time of writing)'],
  ['Government reference stations available', '1 — Denpasar Lumintang (KLHK), via AQICN'],
  ['Archive depth', 'Earliest record 27 September 2023; 4,197 station-days total; longest single station 572 days'],
  ['Collection interval', '15 minutes, continuous'],
  ['Correction applied', 'US-EPA 2021 humidity correction, on 2 of 8 networks, since 21 July 2026'],
  ['Published intervals', 'Raw (15-minute), hourly, daily'],
  ['Licence', 'Open, attribution requested; full archive downloadable as JSON or CSV'],
]));

// 3
body.push(H1('3.  The networks we ingest'));
body.push(P('Each network is polled independently. A network that fails or times out is simply absent from that cycle; it never blocks or degrades the others. The upstream timeout is 8 seconds per request.'));
body.push(TABLE([1450, 2750, 1750, 1650, 2000],
  ['Network', 'What it is', 'Instrument', 'Access', 'Catalogued stations'], [
  ['AirGradient', 'Open community network; the densest source in Bali', 'AirGradient O-1PST (Plantower PM module)', 'Public API, no key', '19'],
  ['OpenAQ', [[ 'Aggregator. ' ], ['In Bali, every OpenAQ station is an AirGradient unit relayed onward', { bold: true }], [' — see §6']], '(relayed)', 'Public API, key', '22'],
  ['IQAir', 'Commercial network; mixture of private hosts and contributors', 'Various', 'Public station pages', '12'],
  ['Smart Citizen', 'Open citizen-science platform (Fab Lab Barcelona)', 'SmartCitizen Kit 2.3', 'Public API', '11'],
  ['Nafas', 'Indonesian commercial network', 'Nafas Foundation sensor', 'Public JSON feed', '7'],
  ['AQICN / WAQI', [['Aggregator; carries the '], ['KLHK government reference station', { bold: true }]], 'Reference-grade (government); GAIA (community)', 'Public API, token', '2'],
  ['Airly', 'Commercial network', 'Airly sensor', 'Public API, key', '2'],
  ['Community', 'Sensors contributed directly to this archive by residents', 'Various (e.g. Winsen ZH03B)', 'Direct push to our API', '1'],
]));
body.push(SPACER(160));
body.push(RP([['Geographic filter. ', { bold: true }], ['All networks are filtered to the same Bali bounding box: latitude −9.2 to −8.0, longitude 114.4 to 115.8. The filter is applied identically in the live aggregator and the archive worker.']], { before: 120 }));
body.push(RP([['On the single government station. ', { bold: true }], ['Of 78 catalogued stations, exactly one is a government reference instrument: Denpasar Lumintang (KLHK), reached through AQICN. It is not enumerated by AQICN’s map endpoint and has to be probed directly by station ID. This is the principal monitoring gap in the record and is the main reason the archive exists in its present form.']]));

// 4
body.push(H1('4.  Collection schedule'));
body.push(P('Three scheduled processes run continuously on Cloudflare’s edge network.'));
body.push(TABLE([2000, 2600, 5000], ['Process', 'Schedule', 'Function'], [
  ['Universal archive', [['*/15 * * * *', { font: MONO }], [' — every 15 minutes, on the hour and at :15, :30, :45']], 'Polls all live networks, writes one snapshot row per reporting station, upserts the station catalogue, rolls up hourly and daily aggregates'],
  ['IQAir capture', [['7,22,37,52 * * * *', { font: MONO }], [' — every 15 minutes, offset by 7 minutes']], 'IQAir publishes only via station pages, so these are captured separately. One rotating group of ≤3 stations per tick (4 groups, full cycle each hour) to stay inside execution limits'],
  ['Archive watchdog', 'Runs within the IQAir tick', 'If the universal archive has not written for 90 minutes, the watchdog triggers a recovery run. Added after a CPU-limit failure caused a 60-minute hole in the record'],
]));
body.push(SPACER(160));
body.push(RP([['Deliberate offset. ', { bold: true }], ['The IQAir schedule is offset from the universal archive so the two never contend for the same execution window.']], { before: 120 }));
body.push(RP([['Retry behaviour. ', { bold: true }], ['The archive’s fetch of the live aggregate retries three times with linear back-off. A single transient failure previously dropped an entire 15-minute tick with nothing to notice it.']]));
body.push(RP([['Idempotency. ', { bold: true }], ['Every write is keyed. Re-running any tick is a no-op — reruns cannot double-count or corrupt the record.']]));

// 5
body.push(H1('5.  Data corrections'));
body.push(H2('5.1  What is corrected, and what is not'));
body.push(RP([['We apply exactly one correction: the '], ['US-EPA 2021 humidity correction for Plantower-based optical sensors', { bold: true }], ['. It is applied to '], ['two networks only', { bold: true }], [' — AirGradient and PurpleAir — because those are the two whose public feeds carry an uncorrected Plantower reading.']]));
body.push(RP([['All six other networks are published exactly as supplied.', { bold: true }], [' We do not adjust, scale, calibrate or reconcile them.']]));
body.push(RP([['Correction has been applied since '], ['21 July 2026', { bold: true }], ['. Rows archived before that date are uncorrected, and the API reports this per station in the field '], ['pm25_correction_applied_since', { font: MONO }], ['.']]));

body.push(H2('5.2  Why the correction is necessary'));
body.push(P('A Plantower module sizes particles optically. In humid air, water-swollen particles scatter light as though they carried more mass than they do, so the sensor over-reads. Bali’s 55–70% relative humidity inflates uncorrected readings substantially.'));
body.push(P('AirGradient applies this same formula to produce the corrected value shown on its own dashboard, but that field is exposed only on the device’s local API and its token-gated cloud API — never on the anonymous public feed we read. The algorithm is published and we already ingest both required inputs, so we compute it ourselves rather than publish values we know run high.'));

body.push(H2('5.3  The formula'));
body.push(RP([['Let '], ['a', { font: MONO, bold: true }], [' = raw PM2.5 (µg/m³) and '], ['h', { font: MONO, bold: true }], [' = relative humidity (%):']]));
[
  'a < 30            →   0.524·a − 0.0862·h + 5.75',
  '',
  '30 ≤ a < 50       →   f = a/20 − 1.5',
  '                      (0.786·f + 0.524·(1−f))·a − 0.0862·h + 5.75',
  '',
  '50 ≤ a < 210      →   0.786·a − 0.0862·h + 5.75',
  '',
  '210 ≤ a < 260     →   f = a/50 − 4.2',
  '                      (0.69·f + 0.786·(1−f))·a − 0.0862·h·(1−f)',
  '                      + 2.966·f + 5.75·(1−f) + 0.000884·a²·f',
  '',
  'a ≥ 260           →   2.966 + 0.69·a + 0.000884·a²',
].forEach(l => body.push(CODE(l)));
body.push(SPACER(140));
body.push(P('Negative results are clamped to zero, per the same EPA guidance.', { before: 100 }));
body.push(RP([['Both inputs are mandatory.', { bold: true }], [' If either the raw reading or the humidity reading is missing, no correction is applied and the raw value is published unchanged, flagged as uncorrected. This is enforced by explicit type checking: a sensor with a failed humidity channel must not be silently corrected as though humidity were 0%, which is the maximum-inflation case.']]));
body.push(RP([['PurpleAir input selection.', { bold: true }], [' The correction is fed PurpleAir’s '], ['cf_1', { font: MONO }], [' field, not '], ['atm', { font: MONO }], ['. The EPA regression was fitted on CF=1 data; the ATM field applies its own high-range scaling, and feeding it under-corrects above roughly 25 µg/m³ — precisely the burn events this archive exists to document.']]));

body.push(H2('5.4  The correction is fully reversible'));
body.push(RP([['Every corrected row stores the exact uncorrected figure in '], ['pm25_raw', { font: MONO }], [', alongside the humidity used. The invariant '], ['epaCorrect(pm25_raw, humidity) = pm25', { font: MONO }], [' holds for every archived row, so the correction can be independently recomputed, audited, or removed entirely. '], ['Nothing the sensor actually reported is discarded.', { bold: true }]]));

body.push(H2('5.5  Measured magnitude'));
body.push(RP([['Across 800 consecutive readings from one AirGradient station ('], ['ag-195872', { font: MONO }], ['):']]));
body.push(TABLE([3200, 3200, 3200], ['Statistic', 'Raw', 'Corrected'], [
  ['Mean', '15.6 µg/m³', '9.9 µg/m³'],
  ['Median', '11.6 µg/m³', '7.0 µg/m³'],
  ['Maximum', '75.5 µg/m³', '60.4 µg/m³'],
]));
body.push(SPACER(160));
body.push(RP([['The raw figure runs higher by a '], ['mean of 5.8 µg/m³', { bold: true }], [', a '], ['median ratio of 1.63×', { bold: true }], ['. In 5.1% of readings — low concentrations in dry conditions — the correction '], ['raises', { italics: true }], [' the value rather than lowering it, which is the expected behaviour of the EPA regression and not an error.']], { before: 120 }));

// 6
body.push(H1('6.  The AirGradient / OpenAQ duplication, and why it matters'));
body.push(P('This section is the most consequential in the document, because it determines what number a given station appears to report.'));
body.push(H2('6.1  The situation'));
body.push(RP([['Every OpenAQ station in Bali is an AirGradient unit relayed through OpenAQ.', { bold: true }], [' The same physical device therefore reaches us twice: once directly from AirGradient, once as an OpenAQ record. The relay reports the device’s coordinates unchanged — all identified pairs match at exactly 0.000000 m separation, not merely “nearby.”']]));
body.push(P('The two copies are not equivalent:'));
body.push(BULLET([['The ', {}], ['direct', { bold: true }], [' feed is timestamped to the minute and carries the humidity inputs, so ', {}], ['we correct it', { bold: true }], ['.']]));
body.push(BULLET([['The ', {}], ['relayed', { bold: true }], [' copy arrives without those inputs and is published ', {}], ['exactly as OpenAQ supplies it — uncorrected', { bold: true }], ['.']]));

body.push(H2('6.2  Measured difference, same physical device'));
body.push(RP([['Station '], ['ag-195872', { font: MONO }], [' and its relay '], ['oq-6403967', { font: MONO }], [' are one device. Over '], ['295 matched hours (20 August – 2 September 2026)', { bold: true }], [':']]));
body.push(TABLE([3400, 3100, 3100],
  ['Measure', 'AirGradient (direct, corrected)', 'OpenAQ (relay, uncorrected)'], [
  ['Mean PM2.5', '18.7 µg/m³', '27.4 µg/m³'],
  ['Median PM2.5', '13.9 µg/m³', '23.9 µg/m³'],
  ['Maximum', '96.7 µg/m³', '127.8 µg/m³'],
  [[['Hours above WHO 24-hour guideline (15 µg/m³)', { bold: true }]], [['125  (42%)', { bold: true }]], [['209  (71%)', { bold: true }]]],
]));
body.push(SPACER(160));
body.push(RP([['The relay reads higher by a '], ['mean of 8.7 µg/m³', { bold: true }], [', a '], ['median ratio of 1.62×', { bold: true }], [', and reads higher in '], ['82% of matched hours', { bold: true }], ['.']], { before: 120 }));
body.push(CALLOUT([
  ['The policy-relevant point. ', { bold: true }],
  ['These two columns describe the same air, measured by the same instrument, at the same moments. The exceedance rate differs by 29 percentage points depending solely on which copy is read and whether the humidity correction is applied. Any comparison between datasets — ours, a ministry dataset, or a third party’s — must first establish which of these two conventions is in use. Otherwise the comparison measures methodology, not air.'],
]));

body.push(H2('6.3  Temporal resolution also differs'));
body.push(P('Both copies are polled every 15 minutes. They do not carry the same amount of information:'));
body.push(TABLE([3400, 3100, 3100],
  ['Copy', 'Distinct values in 800 polls', 'Median interval between value changes'], [
  ['AirGradient direct', '785', '15 minutes'],
  ['OpenAQ relay', '186', '45 minutes'],
]));
body.push(SPACER(160));
body.push(P('The direct feed genuinely updates each poll. The relay republishes roughly every 45 minutes, so three consecutive polls typically repeat one value. For episodic pollution — which is what open burning produces — the relay materially understates short peaks.', { before: 120 }));

body.push(H2('6.4  How we resolve it'));
body.push(RP([['On the public map, a confirmed pair is collapsed to '], ['one pin: the direct feed, always.', { bold: true }]]));
body.push(BULLET([['Suppression is ', {}], ['unconditional', { bold: true }], [' once a pair is established.']]));
body.push(BULLET([['There is ', {}], ['no numeric failover', { bold: true }], [' to the relay. If the direct feed goes quiet, the pin is shown as stale and excluded from published figures — it does not silently switch to the higher uncorrected number. Swapping between the two made a single pin jump 20–45% for the same air.']]));
body.push(BULLET([['Pairing is confirmed against our own archive, not a single poll, so a pair survives a temporarily missing reading. A twin that has produced no archived reading for ', {}], ['36 hours', { bold: true }], [' is treated as departed and the relay stands alone again.']]));
body.push(BULLET([['If the AirGradient unit leaves the network permanently, no pair forms and the OpenAQ record is published normally.']]));
body.push(RP([['Both series are archived in full and both remain published through the API, under their own station IDs.', { bold: true }], [' The de-duplication above is a '], ['display', { italics: true }], [' decision on the public map only. No historical data is discarded, and a researcher can retrieve either or both.']], { before: 120 }));

// 7
body.push(H1('7.  Other de-duplication rules'));
body.push(TABLE([2600, 1400, 5600], ['Rule', 'Radius', 'Behaviour'], [
  ['AirGradient ↔ OpenAQ relay pairing', '1 m', 'Exact-coordinate identity; direct feed always wins (§6)'],
  ['AirGradient vs. other networks', '300 m', 'An AirGradient pin is dropped if a different network already holds that location, so established station identities and their longer histories win. OpenAQ is exempt, for the reason in §6'],
  ['Airly vs. Nafas', '300 m', 'Airly is dropped near a live Nafas station. If Nafas is not reporting, Airly is retained as failover'],
  ['Smart Citizen', '—', 'De-duplicated against existing stations on the same basis'],
  ['IQAir mirrors', '—', 'Where IQAir republishes a sensor already ingested directly (e.g. a PurpleAir unit), both copies are flagged together so a filtered analysis cannot lose one and keep the other'],
]));
body.push(SPACER(160));
body.push(P('The tightest rule is deliberately the 1 m relay rule. A wider radius is unsafe for identity matching: anyone can register a device on a public network and enter arbitrary coordinates, and a 300 m rule could allow an unrelated registration to suppress a genuine station. At 1 m, with the relay reporting the device’s own coordinates unchanged, nothing unrelated can qualify.', { before: 120 }));

// 8
body.push(H1('8.  What we exclude, and when'));
body.push(H2('8.1  Staleness'));
body.push(RP([['A reading older than its network’s threshold is marked stale, rendered muted on the map, and '], ['excluded from all island-wide statistics', { bold: true }], ['. It is never deleted.']]));
body.push(TABLE([2200, 1800, 5600], ['Network', 'Threshold', 'Reason'], [
  ['AirGradient', '6 hours', 'Normally reports every few minutes; a 6-hour gap is a dead sensor, not a slow one'],
  ['OpenAQ', '6 hours', 'Republishes hourly and its timestamps are honest, so an old timestamp means genuinely old data'],
  ['All others', '24 hours', 'Hourly and daily-aggregate networks can legitimately lag'],
]));
body.push(SPACER(160));
body.push(RP([['Staleness is computed as the '], ['greater', { bold: true }], [' of two ages: the upstream timestamp, and the moment we recorded the reading. Where the two disagree, the older is believed.']], { before: 120 }));

body.push(H2('8.2  Readings never archived'));
body.push(BULLET([['Frozen sensors. ', { bold: true }], ['If a device’s own reported reading time is more than 48 hours behind the present, the catalogue entry is updated but no snapshot is written. This prevents a stuck sensor from filling the archive with a repeated stale value stamped as though fresh.']]));
body.push(BULLET([['Null readings coerced to zero. ', { bold: true }], ['A device whose PM module has failed while its network connection persists reports a null value. These are rejected explicitly. Numeric coercion would turn null into a finite 0.0 and archive a false “clean air” record — the most damaging possible failure direction.']]));
body.push(BULLET([['Missing or unparseable timestamps. ', { bold: true }], ['A reading that cannot demonstrate its own freshness is rejected rather than treated as current.']]));

body.push(H2('8.3  Quality flags'));
body.push(RP([['Two flags mark stations whose readings are real but should not enter ambient statistics. '], ['Flagged stations are published in full — every reading is served exactly as recorded — and excluded from every island-wide figure on the site.', { bold: true }]]));
body.push(BULLET([['suspected_indoor', { bold: true, }], [' (3 stations): measuring a room, not ambient air.']]));
body.push(BULLET([['suspected_malfunctioning', { bold: true }], [' (1 station): reporting values that cannot be reconciled with any neighbouring sensor. Currently one IQAir station reading 70–215 µg/m³ while all nine stations within 15 km read 10–35.']]));
body.push(P('The flag is a judgement about the device, never a modification of its data.'));

body.push(H2('8.4  Offline retention'));
body.push(P('When a station stops reporting permanently, its pin remains as a grey marker carrying its last archived date. Months of history never silently vanish because a device died. These carry no current reading and are excluded from all live statistics.'));

// 9
body.push(H1('9.  Limitations — what this archive cannot tell you'));
body.push(P('Stated plainly, because a reference document that omits them is not usable for policy.'));
body.push(NUM([['We cannot measure dioxins or furans. ', { bold: true }], ['PM2.5 and VOC sensors do not speciate. Where burning plastic is the concern, dioxins are among the most serious hazards, and every network in this document — including ours — measures a proxy, not the most toxic component of the smoke. Proper dioxin measurement requires laboratory sampling.']]));
body.push(NUM([['We cannot attribute a reading to a source. ', { bold: true }], ['A PM2.5 sensor weighs smoke; it cannot chemically distinguish burning plastic from burning agricultural residue from vehicle exhaust. Consistent daily timing patterns across many stations are suggestive of a shared cause; they are not proof of one. Any confident claim about a specific facility — in either direction — is unproven by this data.']]));
body.push(NUM([['There is no calibration reference available in Bali. ', { bold: true }], ['We know of no facility where a citizen-operated monitor can be checked against a reference-grade instrument at both high and low concentrations. Until one exists, every low-cost sensor’s error — including whether it is a constant offset or a scaling factor — is an estimate. This is the single highest-leverage gap in the record, and it needs an institution with a reference instrument to close it.']]));
body.push(NUM([['Low-cost sensors drift in tropical humidity. ', { bold: true }], ['The correction in §5 addresses the dominant known bias. It does not address per-device manufacturing variation, which AirGradient handles with an unpublished batch-level factor we cannot reproduce.']]));
body.push(NUM([['Coverage is uneven and volunteer-determined. ', { bold: true }], ['Sensors exist where residents installed them, which is not where pollution is worst. Sanur, Ubud and Gianyar are materially under-covered. Absence of data is not evidence of clean air.']]));
body.push(NUM([['The network is not under our control. ', { bold: true }], ['Commercial networks have withdrawn from Bali mid-season before, taking their live feeds with them. Everything they published while present remains in this archive.']]));

// 10
body.push(H1('10.  Aggregation, intervals, and access'));
body.push(H2('10.1  Intervals'));
body.push(TABLE([2000, 7600], ['Interval', 'Definition'], [
  ['Raw', '15-minute snapshots exactly as fetched. Not available for IQAir stations, which publish hourly'],
  ['Hourly', 'Hourly means. Native for Nafas and IQAir; bucketed from raw snapshots for all other networks'],
  ['Daily', 'Daily means, with minimum, maximum and sample count'],
]));
body.push(SPACER(160));
body.push(RP([['Time basis. ', { bold: true }], ['All instants are UTC, ISO-8601. '], ['Daily aggregates are WITA (UTC+8) calendar days', { bold: true }], [', not UTC days — the local day is the meaningful unit for a Bali reader, and each response states which basis applies.']], { before: 120 }));
body.push(RP([['Sample counts. ', { bold: true }], ['Every aggregate row carries a sample count. Some older daily rows carry a count of 1 — a single backfilled observation, with minimum = maximum = mean. A low sample count should be treated as a weak average.']]));

body.push(H2('10.2  AQI conversion'));
body.push(P('Where a network publishes only an AQI value, PM2.5 is derived using the standard US-EPA breakpoint table. Values obtained this way are marked as such.'));

body.push(H2('10.3  Open access'));
body.push(P('The full archive is public, requires no account, and is available as JSON or CSV:'));
body.push(CODE('https://baliairdispatch.com/api/v1'));
body.push(SPACER(140));
body.push(BULLET([['/api/v1/stations', { bold: true }], [' — full catalogue with coordinates, network, coverage dates, correction date and quality flags']]));
body.push(BULLET([['/api/v1/latest', { bold: true }], [' — most recent reading held for every station']]));
body.push(BULLET([['/api/v1/measurements', { bold: true }], [' — the time series; raw, hourly or daily; paged by cursor']]));
body.push(RP([['Every response carries the licence terms and the semantic notes summarised in this document. '], ['We would welcome the Ministry’s technical staff testing any figure in this document directly against that endpoint.', { bold: true }]], { before: 120 }));

// 11
body.push(H1('11.  Standing offers'));
body.push(P('Three things this project can do that may be useful, offered without condition:'));
body.push(NUM([['Provide the complete archive ', { bold: true }], ['in any format required, including the uncorrected series, for independent analysis.']]));
body.push(NUM([['Host a reference co-location. ', { bold: true }], ['If the Ministry can make a reference-grade instrument available even briefly, co-locating it with community sensors would establish the error characteristics of every low-cost device on this island. That result would be published openly and would benefit any party using low-cost sensor data in Indonesia, not only this project.']]));
body.push(NUM([['Add monitoring where the Ministry considers it useful. ', { bold: true }], ['Coverage decisions are currently made by whoever volunteers to host a sensor. Direction toward locations of policy interest — waste-processing facilities, schools, under-covered regencies — would improve the record for everyone.']]));

body.push(HR());
body.push(RP([['Bali Air Dispatch is an independent, non-commercial, public-interest air-quality archive. It is not affiliated with any government body or commercial monitoring network. It sells nothing and carries no advertising. Readings originate from the independent networks named in §3 and remain subject to their own terms; this project aggregates and preserves them.']], { italics: true, color: FAINT, size: 18, after: 120 }));
body.push(RP([['Contact:  baliair@protonmail.com']], { color: FAINT, size: 18 }));

// ── assemble ──────────────────────────────────────────────────────────
const doc = new Document({
  creator: 'Bali Air Dispatch',
  title: 'Bali Air Dispatch — Data Sources and Methodology',
  description: 'Technical reference: sensor networks, collection schedule, corrections and limitations.',
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
  fs.writeFileSync(process.argv[2], b);
  console.log('written:', process.argv[2], b.length, 'bytes');
});
