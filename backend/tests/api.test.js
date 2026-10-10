/**
 * tests/api.test.js
 * Integration tests for the Express API routes using supertest.
 * Puppeteer is NOT launched — PDF conversion is mocked so CI stays fast.
 */

const request = require('supertest');
const app     = require('../api/index');

// ── Mock the pdf module so Puppeteer never launches in tests ──────────────────
jest.mock('../api/pdf', () => ({
  convert: jest.fn().mockResolvedValue(
    // Minimal valid PDF header so Content-Length resolves
    Buffer.from('%PDF-1.4 mock\n%%EOF\n')
  ),
}));

// ── Mock the docx module for API-level tests (docx.test.js tests it deeply) ───
jest.mock('../api/docx', () => ({
  convert: jest.fn().mockResolvedValue(
    // PK ZIP magic bytes — valid enough for API response tests
    Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(20)])
  ),
}));

// ── Health check ──────────────────────────────────────────────────────────────

describe('GET /api', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

// ── POST /api/convert/pdf ─────────────────────────────────────────────────────

describe('POST /api/convert/pdf', () => {
  test('returns 400 when html is missing', async () => {
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ title: 'Test' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('html is required');
  });

  test('returns 400 when html is not a string', async () => {
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ html: { evil: true } })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('html must be a string');
  });

  test('returns 200 with pdf content-type for valid input', async () => {
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ html: '<p>Hello</p>', title: 'Test PDF' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  test('passes pageSize and font options to converter', async () => {
    const { convert } = require('../api/pdf');
    convert.mockClear();

    await request(app)
      .post('/api/convert/pdf')
      .send({ html: '<p>x</p>', title: 'T', pageSize: 'Letter', font: 'serif' })
      .set('Content-Type', 'application/json');

    expect(convert).toHaveBeenCalledWith(
      '<p>x</p>',
      'T',
      expect.objectContaining({ pageSize: 'Letter', font: 'serif' })
    );
  });

  test('returns 200 when title is omitted (falls back to "document")', async () => {
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ html: '<p>Hi</p>' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
  });

  test('sets Content-Disposition attachment header', async () => {
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ html: '<p>x</p>', title: 'My Report' })
      .set('Content-Type', 'application/json');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/My_Report\.pdf/);
  });
});

// ── POST /api/convert/docx ────────────────────────────────────────────────────

describe('POST /api/convert/docx', () => {
  test('returns 400 when html is missing', async () => {
    const res = await request(app)
      .post('/api/convert/docx')
      .send({ title: 'Test' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('html is required');
  });

  test('returns 400 when html is not a string', async () => {
    const res = await request(app)
      .post('/api/convert/docx')
      .send({ html: 42 })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('html must be a string');
  });

  test('returns 200 with docx content-type for valid input', async () => {
    const res = await request(app)
      .post('/api/convert/docx')
      .send({ html: '<p>Hello</p>', title: 'Test DOCX' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(
      /application\/vnd\.openxmlformats-officedocument/
    );
  });

  test('passes sourceUrl and options to converter', async () => {
    const { convert } = require('../api/docx');
    convert.mockClear();

    await request(app)
      .post('/api/convert/docx')
      .send({
        html:          '<p>x</p>',
        title:         'T',
        sourceUrl:     'https://example.com',
        pageSize:      'A4',
        font:          'mono',
        includeImages: false,
      })
      .set('Content-Type', 'application/json');

    expect(convert).toHaveBeenCalledWith(
      '<p>x</p>',
      'T',
      'https://example.com',
      expect.objectContaining({
        pageSize:      'A4',
        font:          'mono',
        includeImages: false,
      })
    );
  });

  test('sets Content-Disposition attachment header', async () => {
    const res = await request(app)
      .post('/api/convert/docx')
      .send({ html: '<p>x</p>', title: 'My Article' })
      .set('Content-Type', 'application/json');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/My_Article\.docx/);
  });

  test('sanitizes dangerous characters from filename', async () => {
    const res = await request(app)
      .post('/api/convert/docx')
      .send({ html: '<p>x</p>', title: 'Title/With:Bad*Chars' })
      .set('Content-Type', 'application/json');
    // Strip the surrounding RFC 5987 double-quotes before checking for bad chars
    // so the assertion doesn't flag the legitimate quote delimiters in the header.
    const filenameValue = res.headers['content-disposition']
      .replace(/attachment;\s*filename="([^"]*)"/, '$1');
    expect(filenameValue).not.toMatch(/[/:*?"<>| ]/);
  });
});

// ── CORS headers ──────────────────────────────────────────────────────────────

describe('CORS', () => {
  test('GET /api responds with Access-Control-Allow-Origin: *', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('OPTIONS preflight returns 204', async () => {
    const res = await request(app)
      .options('/api/convert/pdf')
      .set('Origin', 'chrome-extension://abc')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe('Timeout', () => {
  test('returns 504 when converter times out', async () => {
    const { convert } = require('../api/pdf');
    convert.mockImplementationOnce(
      () => new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Conversion timed out.')), 10)
      )
    );

    // Temporarily shorten the timeout constant isn't possible without patching,
    // so we inject a timed-out error directly via the mock instead.
    // The route maps "timed out" → 504.
    const res = await request(app)
      .post('/api/convert/pdf')
      .send({ html: '<p>x</p>', title: 'Slow' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });
});
