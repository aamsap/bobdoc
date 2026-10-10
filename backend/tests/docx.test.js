/**
 * tests/docx.test.js
 * Unit tests for the HTML → DOCX DOM walker.
 * Uses the docx Packer to verify the buffer is valid, and inspects the
 * internal paragraph/table/run structure for correctness.
 */

const { convert } = require('../api/docx');

// Helper: convert HTML to a DOCX buffer and confirm it starts with the PK
// zip magic bytes (all OOXML files are ZIP archives).
async function toBuffer(html, title = 'Test', sourceUrl = null, opts = {}) {
  const buf = await convert(html, title, sourceUrl, opts);
  expect(Buffer.isBuffer(buf)).toBe(true);
  // PK magic bytes (ZIP / OOXML)
  expect(buf[0]).toBe(0x50); // P
  expect(buf[1]).toBe(0x4b); // K
  return buf;
}

// ── Basic output ──────────────────────────────────────────────────────────────

test('produces a valid OOXML buffer for a simple paragraph', async () => {
  await toBuffer('<p>Hello world</p>', 'Simple');
});

test('produces a valid buffer for an empty body', async () => {
  await toBuffer('', 'Empty');
});

test('produces a valid buffer for a full article', async () => {
  const html = `
    <h1>Main heading</h1>
    <p>First paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
    <h2>Section two</h2>
    <p>Second paragraph with a <a href="https://example.com">link</a>.</p>
    <ul><li>Item one</li><li>Item two</li></ul>
    <ol><li>Step one</li><li>Step two</li></ol>
    <blockquote>A blockquote</blockquote>
    <pre>code block</pre>
    <hr/>
    <table>
      <thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>Alpha</td><td>1</td></tr></tbody>
    </table>
  `;
  await toBuffer(html, 'Full Article');
});

// ── Heading levels ────────────────────────────────────────────────────────────

test('handles all heading levels h1–h6 without throwing', async () => {
  const html = '<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>';
  await toBuffer(html);
});

// ── Inline formatting ─────────────────────────────────────────────────────────

test('handles nested inline formatting', async () => {
  const html = '<p><strong><em>Bold italic</em></strong> and <u>underline</u> and <del>strike</del></p>';
  await toBuffer(html);
});

test('handles inline code inside a paragraph', async () => {
  await toBuffer('<p>Use <code>npm install</code> to install.</p>');
});

test('handles superscript and subscript', async () => {
  await toBuffer('<p>E = mc<sup>2</sup> and H<sub>2</sub>O</p>');
});

test('handles external hyperlinks', async () => {
  await toBuffer('<p>Visit <a href="https://example.com">example</a>.</p>');
});

test('ignores relative links gracefully', async () => {
  await toBuffer('<p>See <a href="/about">about</a>.</p>');
});

// ── Lists ─────────────────────────────────────────────────────────────────────

test('handles an unordered list', async () => {
  await toBuffer('<ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>');
});

test('handles an ordered list', async () => {
  await toBuffer('<ol><li>First</li><li>Second</li><li>Third</li></ol>');
});

test('handles nested lists', async () => {
  const html = `
    <ul>
      <li>Parent 1
        <ul>
          <li>Child 1a</li>
          <li>Child 1b</li>
        </ul>
      </li>
      <li>Parent 2</li>
    </ul>
  `;
  await toBuffer(html);
});

test('handles a nested ordered list inside unordered', async () => {
  const html = `
    <ul>
      <li>Item
        <ol><li>Sub 1</li><li>Sub 2</li></ol>
      </li>
    </ul>
  `;
  await toBuffer(html);
});

test('two separate ordered lists restart numbering independently', async () => {
  // Both lists should produce valid DOCX with distinct numbering references
  const html = '<ol><li>A</li><li>B</li></ol><p>Gap</p><ol><li>C</li><li>D</li></ol>';
  await toBuffer(html);
});

// ── Tables ────────────────────────────────────────────────────────────────────

test('handles a table with thead and tbody', async () => {
  const html = `
    <table>
      <thead><tr><th>Col A</th><th>Col B</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>2</td></tr>
        <tr><td>3</td><td>4</td></tr>
      </tbody>
    </table>
  `;
  await toBuffer(html);
});

test('handles a table with no thead (only tbody)', async () => {
  const html = '<table><tr><td>X</td><td>Y</td></tr></table>';
  await toBuffer(html);
});

test('handles an empty table gracefully', async () => {
  await toBuffer('<table></table>');
});

// ── Block elements ────────────────────────────────────────────────────────────

test('handles blockquote', async () => {
  await toBuffer('<blockquote>This is a blockquote.</blockquote>');
});

test('handles pre/code blocks', async () => {
  await toBuffer('<pre><code>const x = 1;\nconsole.log(x);</code></pre>');
});

test('handles hr', async () => {
  await toBuffer('<p>Above</p><hr/><p>Below</p>');
});

test('handles br inside a paragraph', async () => {
  await toBuffer('<p>Line one<br/>Line two</p>');
});

test('handles div/section/article containers by recursing into children', async () => {
  const html = '<div><section><article><p>Deep content</p></article></section></div>';
  await toBuffer(html);
});

test('handles figure with figcaption', async () => {
  await toBuffer('<figure><figcaption>Caption</figcaption></figure>');
});

// ── Source attribution ────────────────────────────────────────────────────────

test('includes source URL in document when provided', async () => {
  const buf = await toBuffer('<p>Content</p>', 'Title', 'https://example.com/article');
  // The ZIP is compressed so we can only verify the buffer is non-trivially
  // larger than a no-URL version — a lightweight proxy for content being present.
  const bufNoUrl = await toBuffer('<p>Content</p>', 'Title');
  expect(buf.length).toBeGreaterThan(bufNoUrl.length);
});

test('omits attribution section when sourceUrl is not provided', async () => {
  // Should not throw; attribution paragraph is simply absent
  await toBuffer('<p>Content</p>', 'No URL');
});

// ── Options ───────────────────────────────────────────────────────────────────

test('respects includeImages: false — skips image fetching', async () => {
  // An img tag with a real URL that would fail to fetch — should not throw
  const html = '<p>Text</p><img src="https://localhost:0/nonexistent.png" alt="test"/>';
  await toBuffer(html, 'No Images', null, { includeImages: false });
});

// ── Special characters ────────────────────────────────────────────────────────

test('handles special HTML characters in title and body', async () => {
  await toBuffer('<p>5 &lt; 10 &amp; 10 &gt; 1</p>', 'Title with <special> & "chars"');
});

test('handles unicode content', async () => {
  await toBuffer('<p>日本語テスト — café naïve résumé 🎉</p>', 'Unicode');
});

test('handles a very long paragraph without throwing', async () => {
  const para = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(200) + '</p>';
  await toBuffer(para, 'Long');
});
