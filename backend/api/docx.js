/**
 * docx.js
 * Converts a clean HTML string to a proper .docx file using the `docx` library.
 * Walks the DOM produced by Readability and maps each element to a Word construct.
 */

const { parse } = require('node-html-parser');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  ExternalHyperlink, UnderlineType, ShadingType,
  convertInchesToTwip,
} = require('docx');

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * @param {string} html   Clean article HTML (from Readability)
 * @param {string} title  Document title
 * @returns {Promise<Buffer>} DOCX binary buffer
 */
async function convert(html, title) {
  const root     = parse(html);
  const children = Array.from(root.childNodes);
  const sections = [];

  // Title paragraph — use HEADING_1, TITLE does not exist in docx@8
  sections.push(
    new Paragraph({
      text:    title,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 240 },
    })
  );

  for (const node of children) {
    const els = walkNode(node);
    sections.push(...els);
  }

  const doc = new Document({
    // Numbered list definition — required or any ol reference crashes Word
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: 'decimal',
              text:   '%1.',
              alignment: 'left',
              style: {
                paragraph: {
                  indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) },
                },
              },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 24 }, // 12pt
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
        children: sections,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ─── Node walker ─────────────────────────────────────────────────────────────

function walkNode(node) {
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
      return [paragraph(node)];

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
          children: inlineRuns(node),
          indent:   { left: convertInchesToTwip(0.5) },
          spacing:  { before: 120, after: 120 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 8 },
          },
        }),
      ];

    case 'ul':
      return listItems(node, false);

    case 'ol':
      return listItems(node, true);

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
      return [buildTable(node)];

    case 'figure': {
      const results = [];
      for (const child of node.childNodes) results.push(...walkNode(child));
      return results;
    }

    case 'img':
      return [];

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
      return [new Paragraph({ children: inlineRuns(node) })];

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
      for (const child of node.childNodes) results.push(...walkNode(child));
      return results;
    }

    default: {
      const results = [];
      for (const child of node.childNodes) results.push(...walkNode(child));
      return results;
    }
  }
}

// ─── Block helpers ────────────────────────────────────────────────────────────

function heading(node, level) {
  return new Paragraph({
    children: inlineRuns(node),
    heading:  level,
    spacing:  { before: 240, after: 100 },
  });
}

function paragraph(node) {
  return new Paragraph({
    children: inlineRuns(node),
    spacing:  { after: 120 },
  });
}

function listItems(listNode, ordered) {
  const items = [];

  for (const child of listNode.childNodes) {
    if (child.tagName?.toLowerCase() !== 'li') continue;

    items.push(
      new Paragraph({
        children:  inlineRuns(child),
        // bullet handles unordered; numbering handles ordered
        bullet:    ordered ? undefined : { level: 0 },
        numbering: ordered ? { reference: 'default-numbering', level: 0 } : undefined,
        spacing:   { after: 60 },
      })
    );
  }

  return items;
}

function buildTable(tableNode) {
  const rows = [];

  for (const child of tableNode.childNodes) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const row of child.childNodes) {
        if (row.tagName?.toLowerCase() === 'tr') {
          rows.push(buildRow(row, tag === 'thead'));
        }
      }
    } else if (tag === 'tr') {
      rows.push(buildRow(child, false));
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

function buildRow(rowNode, isHeader) {
  const cells = [];

  for (const cell of rowNode.childNodes) {
    const tag = cell.tagName?.toLowerCase();
    if (tag !== 'td' && tag !== 'th') continue;

    cells.push(
      new TableCell({
        children: [
          new Paragraph({
            children: inlineRuns(cell),
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

function inlineRuns(node, opts = {}) {
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
        runs.push(...inlineRuns(child, { ...opts, bold: true }));
        break;

      case 'em':
      case 'i':
        runs.push(...inlineRuns(child, { ...opts, italics: true }));
        break;

      case 'u':
        runs.push(...inlineRuns(child, { ...opts, underline: { type: UnderlineType.SINGLE } }));
        break;

      case 's':
      case 'del':
        runs.push(...inlineRuns(child, { ...opts, strike: true }));
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
        runs.push(...inlineRuns(child, { ...opts, superScript: true }));
        break;

      case 'sub':
        runs.push(...inlineRuns(child, { ...opts, subScript: true }));
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
        });
        if (href && href.startsWith('http')) {
          runs.push(new ExternalHyperlink({ link: href, children: inner }));
        } else {
          runs.push(...inner);
        }
        break;
      }

      case 'img':
        break;

      default:
        runs.push(...inlineRuns(child, opts));
        break;
    }
  }

  return runs;
}

module.exports = { convert };
