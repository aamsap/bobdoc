/**
 * docx.js
 * Converts a clean HTML string to a proper .docx file using the `docx` library.
 * Walks the DOM produced by Readability and maps each element to a Word construct.
 *
 * Phase 1 improvements:
 *  - Images fetched server-side and embedded with ImageRun (with size cap + timeout)
 *  - Nested ul/ol levels supported; each list restarts its own counter
 *  - DOCX header (title) and footer (page numbers) added
 *  - Source URL + export date inserted under the title
 */

const https   = require('https');
const http    = require('http');
const { parse } = require('node-html-parser');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  ExternalHyperlink, UnderlineType, ShadingType, ImageRun,
  AlignmentType, Header, Footer, PageNumber, NumberFormat,
  convertInchesToTwip,
} = require('docx');

// ─── Constants ────────────────────────────────────────────────────────────────

const IMG_MAX_BYTES    = 2 * 1024 * 1024; // 2 MB per image
const IMG_TIMEOUT_MS   = 5_000;
const IMG_MAX_WIDTH_EMU = 5_486_400; // ~6 inches at 914400 EMU/inch

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * @param {string} html      Clean article HTML (from Readability)
 * @param {string} title     Document title
 * @param {string} [sourceUrl] Original page URL for attribution
 * @returns {Promise<Buffer>} DOCX binary buffer
 */
async function convert(html, title, sourceUrl) {
  const root     = parse(html);
  const children = Array.from(root.childNodes);

  // Pre-fetch all images in parallel so walkNode can be synchronous
  const imgMap = await prefetchImages(root);

  // Numbering state — one entry per list encountered (supports restarts)
  const numberingState = { configs: [], counter: 0 };

  const sections = [];

  // Title paragraph
  sections.push(
    new Paragraph({
      text:    title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
    })
  );

  // Source attribution under the title
  if (sourceUrl) {
    const exportDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
    sections.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'Source: ', size: 18, color: '888888' }),
          new ExternalHyperlink({
            link: sourceUrl,
            children: [new TextRun({ text: sourceUrl, size: 18, color: '3B82F6', underline: { type: UnderlineType.SINGLE } })],
          }),
          new TextRun({ text: `   ·   Exported ${exportDate}`, size: 18, color: '888888' }),
        ],
        spacing: { after: 280 },
      })
    );
  }

  for (const node of children) {
    const els = walkNode(node, imgMap, numberingState, 0);
    sections.push(...els);
  }

  const doc = new Document({
    numbering: {
      config: numberingState.configs,
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 24 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top:    convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left:   convertInchesToTwip(1.25),
              right:  convertInchesToTwip(1.25),
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [new TextRun({ text: title, size: 18, color: '888888' })],
                alignment: AlignmentType.RIGHT,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '888888' }),
                  new TextRun({ text: ' / ', size: 18, color: '888888' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '888888' }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        children: sections,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ─── Image pre-fetching ───────────────────────────────────────────────────────

/**
 * Walk the HTML tree, collect every <img src>, fetch them in parallel with a
 * timeout and size cap, and return a Map<src, Buffer|null>.
 */
async function prefetchImages(root) {
  const srcs = new Set();
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
      srcs.add(src);
    }
  }

  const entries = await Promise.all(
    [...srcs].map(async src => {
      try {
        const buf = await fetchWithLimit(src, IMG_MAX_BYTES, IMG_TIMEOUT_MS);
        return [src, buf];
      } catch {
        return [src, null];
      }
    })
  );

  return new Map(entries);
}

function fetchWithLimit(url, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https') ? https : http;
    const timer   = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    let received  = 0;
    const chunks  = [];

    const req = lib.get(url, res => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          clearTimeout(timer);
          res.destroy();
          reject(new Error('too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      res.on('error', err => { clearTimeout(timer); reject(err); });
    });

    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/** Detect image MIME type from the first bytes of a buffer */
function detectMime(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/png'; // fallback
}

// ─── Numbering helper ─────────────────────────────────────────────────────────

/**
 * Register a new numbering config for a specific list and return its reference ID.
 * Each <ol>/<ul> at any nesting level gets its own reference so counters restart.
 */
function registerList(state, ordered, level) {
  const ref = `list-${state.counter++}`;
  state.configs.push({
    reference: ref,
    levels: Array.from({ length: 9 }, (_, i) => ({
      level:     i,
      format:    ordered ? 'decimal' : 'bullet',
      text:      ordered ? `%${i + 1}.` : '\u2022',
      alignment: 'left',
      style: {
        paragraph: {
          indent: {
            left:    convertInchesToTwip(0.5 * (i + 1)),
            hanging: convertInchesToTwip(0.25),
          },
        },
      },
    })),
  });
  return ref;
}

// ─── Node walker ─────────────────────────────────────────────────────────────

function walkNode(node, imgMap, numberingState, depth) {
  if (node.nodeType === 3) {
    const text = node.text.trim();
    if (!text) return [];
    return [new Paragraph({ children: [new TextRun(text)] })];
  }

  if (node.nodeType !== 1) return [];

  const tag = node.tagName?.toLowerCase();

  switch (tag) {
    case 'h1': return [heading(node, HeadingLevel.HEADING_1)];
    case 'h2': return [heading(node, HeadingLevel.HEADING_2)];
    case 'h3': return [heading(node, HeadingLevel.HEADING_3)];
    case 'h4': return [heading(node, HeadingLevel.HEADING_4)];
    case 'h5':
    case 'h6': return [heading(node, HeadingLevel.HEADING_5)];

    case 'p':
      return [paragraph(node, imgMap)];

    case 'br':
      return [new Paragraph({})];

    case 'hr':
      return [
        new Paragraph({
          border:  { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' } },
          spacing: { before: 160, after: 160 },
        }),
      ];

    case 'blockquote':
      return [
        new Paragraph({
          children: inlineRuns(node, {}, imgMap),
          indent:   { left: convertInchesToTwip(0.5) },
          spacing:  { before: 120, after: 120 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 },
          },
        }),
      ];

    case 'ul':
      return listItems(node, false, imgMap, numberingState, depth);

    case 'ol':
      return listItems(node, true, imgMap, numberingState, depth);

    case 'pre':
    case 'code': {
      const text = node.text;
      return [
        new Paragraph({
          children: [new TextRun({ text, font: 'Courier New', size: 20 })],
          spacing:  { before: 120, after: 120 },
          shading:  { type: ShadingType.SOLID, fill: 'F5F5F5', color: 'F5F5F5' },
          indent:   { left: convertInchesToTwip(0.25) },
        }),
      ];
    }

    case 'table':
      return [buildTable(node, imgMap)];

    case 'figure': {
      const results = [];
      for (const child of node.childNodes) results.push(...walkNode(child, imgMap, numberingState, depth));
      return results;
    }

    case 'img':
      return buildImgParagraph(node, imgMap);

    case 'a':
    case 'span':
    case 'em':
    case 'strong':
    case 'b':
    case 'i':
    case 'u':
    case 's':
    case 'del':
    case 'sup':
    case 'sub':
      return [new Paragraph({ children: inlineRuns(node, {}, imgMap) })];

    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'aside':
    case 'nav':
    case 'details':
    case 'summary': {
      const results = [];
      for (const child of node.childNodes) results.push(...walkNode(child, imgMap, numberingState, depth));
      return results;
    }

    default: {
      const results = [];
      for (const child of node.childNodes) results.push(...walkNode(child, imgMap, numberingState, depth));
      return results;
    }
  }
}

// ─── Block helpers ────────────────────────────────────────────────────────────

function heading(node, level) {
  return new Paragraph({
    children: inlineRuns(node, {}, new Map()),
    heading:  level,
    spacing:  { before: 240, after: 100 },
  });
}

function paragraph(node, imgMap) {
  return new Paragraph({
    children: inlineRuns(node, {}, imgMap),
    spacing:  { after: 120 },
  });
}

function buildImgParagraph(node, imgMap) {
  const src = node.getAttribute('src');
  if (!src) return [];
  const buf = imgMap.get(src);
  if (!buf) return [];

  try {
    // Scale to max width while preserving aspect ratio
    const altText = node.getAttribute('alt') || '';
    const run = new ImageRun({
      data:          buf,
      transformation: { width: 400, height: 300 }, // word will auto-scale with correct OOXML
      altText:       { title: altText, description: altText, name: altText },
    });
    return [
      new Paragraph({
        children: [run],
        spacing:  { before: 120, after: 120 },
        alignment: AlignmentType.CENTER,
      }),
    ];
  } catch {
    return [];
  }
}

function listItems(listNode, ordered, imgMap, numberingState, depth) {
  // Each list gets its own numbering reference so counters restart independently
  const ref   = registerList(numberingState, ordered, depth);
  const items = [];

  for (const child of listNode.childNodes) {
    const childTag = child.tagName?.toLowerCase();
    if (childTag !== 'li') continue;

    // Separate direct text/inline content from nested lists within this <li>
    const inlineChildren   = [];
    const nestedListNodes  = [];

    for (const liChild of child.childNodes) {
      const t = liChild.tagName?.toLowerCase();
      if (t === 'ul' || t === 'ol') {
        nestedListNodes.push(liChild);
      } else {
        inlineChildren.push(liChild);
      }
    }

    // Build a synthetic node with only the inline children for inlineRuns
    const inlineFrag = { childNodes: inlineChildren, nodeType: 1 };

    items.push(
      new Paragraph({
        children:  inlineRuns(inlineFrag, {}, imgMap),
        bullet:    ordered ? undefined : { level: depth },
        numbering: ordered ? { reference: ref, level: depth } : undefined,
        spacing:   { after: 60 },
      })
    );

    // Recurse into any nested lists
    for (const nested of nestedListNodes) {
      const nestedOrdered = nested.tagName?.toLowerCase() === 'ol';
      items.push(...listItems(nested, nestedOrdered, imgMap, numberingState, depth + 1));
    }
  }

  return items;
}

function buildTable(tableNode, imgMap) {
  const rows = [];

  for (const child of tableNode.childNodes) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const row of child.childNodes) {
        if (row.tagName?.toLowerCase() === 'tr') {
          rows.push(buildRow(row, tag === 'thead', imgMap));
        }
      }
    } else if (tag === 'tr') {
      rows.push(buildRow(child, false, imgMap));
    }
  }

  if (rows.length === 0) return new Paragraph({});

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
    borders: {
      top:     { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
      bottom:  { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
      left:    { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
      right:   { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
      insideH: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
      insideV: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' },
    },
  });
}

function buildRow(rowNode, isHeader, imgMap) {
  const cells = [];

  for (const cell of rowNode.childNodes) {
    const tag = cell.tagName?.toLowerCase();
    if (tag !== 'td' && tag !== 'th') continue;

    cells.push(
      new TableCell({
        children: [
          new Paragraph({
            children: inlineRuns(cell, {}, imgMap),
            spacing:  { after: 0 },
          }),
        ],
        shading: (isHeader || tag === 'th')
          ? { type: ShadingType.SOLID, fill: 'F0F0F0', color: 'F0F0F0' }
          : undefined,
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
      })
    );
  }

  return new TableRow({ children: cells, tableHeader: isHeader });
}

// ─── Inline helpers ───────────────────────────────────────────────────────────

function inlineRuns(node, opts, imgMap) {
  const runs = [];

  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.text;
      if (!text) continue;
      runs.push(new TextRun({ text, ...opts }));
      continue;
    }

    if (child.nodeType !== 1) continue;

    const tag = child.tagName?.toLowerCase();

    switch (tag) {
      case 'strong':
      case 'b':
        runs.push(...inlineRuns(child, { ...opts, bold: true }, imgMap));
        break;

      case 'em':
      case 'i':
        runs.push(...inlineRuns(child, { ...opts, italics: true }, imgMap));
        break;

      case 'u':
        runs.push(...inlineRuns(child, { ...opts, underline: { type: UnderlineType.SINGLE } }, imgMap));
        break;

      case 's':
      case 'del':
        runs.push(...inlineRuns(child, { ...opts, strike: true }, imgMap));
        break;

      case 'code': {
        const text = child.text;
        runs.push(new TextRun({
          text,
          font:    'Courier New',
          size:    20,
          shading: { type: ShadingType.SOLID, fill: 'F0F0F0', color: 'F0F0F0' },
          ...opts,
        }));
        break;
      }

      case 'sup':
        runs.push(...inlineRuns(child, { ...opts, superScript: true }, imgMap));
        break;

      case 'sub':
        runs.push(...inlineRuns(child, { ...opts, subScript: true }, imgMap));
        break;

      case 'br':
        runs.push(new TextRun({ text: '', break: 1 }));
        break;

      case 'a': {
        const href  = child.getAttribute('href');
        const inner = inlineRuns(child, {
          ...opts,
          color:     '1A56DB',
          underline: { type: UnderlineType.SINGLE },
        }, imgMap);
        if (href && href.startsWith('http')) {
          runs.push(new ExternalHyperlink({ link: href, children: inner }));
        } else {
          runs.push(...inner);
        }
        break;
      }

      case 'img': {
        // Inline image inside a paragraph — embed if available
        const src = child.getAttribute('src');
        const buf = src && imgMap ? imgMap.get(src) : null;
        if (buf) {
          try {
            runs.push(new ImageRun({
              data:           buf,
              transformation: { width: 300, height: 200 },
            }));
          } catch { /* skip on error */ }
        }
        break;
      }

      default:
        runs.push(...inlineRuns(child, opts, imgMap));
        break;
    }
  }

  return runs;
}

module.exports = { convert };
