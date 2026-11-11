const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Pool } = require('pg');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function buildPool() {
  let connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const ca =
    process.env.DATABASE_CA_CERT ||
    process.env.PG_CA_CERT ||
    process.env.PGSSLROOTCERT_CONTENT;

  // Avoid conflicts between ssl params in the URL and explicit ssl config.
  try {
    const u = new URL(connectionString);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('sslrootcert');
    u.searchParams.delete('sslcert');
    u.searchParams.delete('sslkey');
    connectionString = u.toString();
  } catch (_) {}

  const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';
  const ssl = ca
    ? { ca, rejectUnauthorized }
    : { rejectUnauthorized };

  return new Pool({ connectionString, ssl });
}

const pool = buildPool();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
      source_name TEXT,
      source_type TEXT,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      published_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pinned BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      source_ids TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_news_source ON news(source_id);
    CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(pinned);
  `);
  await pool.query(
    "ALTER TABLE folders ADD COLUMN IF NOT EXISTS source_ids TEXT NOT NULL DEFAULT '[]'"
  );
  await pool.query("ALTER TABLE news ADD COLUMN IF NOT EXISTS source_name TEXT");
  await pool.query("ALTER TABLE news ADD COLUMN IF NOT EXISTS source_type TEXT");
  await pool.query(`
    UPDATE news n
    SET source_name = s.name,
        source_type = s.type
    FROM sources s
    WHERE n.source_id = s.id
      AND (n.source_name IS NULL OR n.source_name = '')
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  res.end(data);
  return true;
}

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanTitle(t, fallback = 'بدون عنوان') {
  let s = decodeEntities(stripTags(String(t || ''))).replace(/\s+/g, ' ').trim();
  if (!s) s = fallback;
  if (s.length > 240) s = s.slice(0, 237) + '...';
  return s;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'hooshlive/1.0 (+https://localhost) news-fetcher',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function normalizeTelegramUsername(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/\/+$/,'');
  s = s.split(/[/?#]/)[0];
  if (s.startsWith('s/')) s = s.slice(2);
  return s;
}

async function fetchTelegram(source) {
  const cfg = safeJson(source.config);
  const username = normalizeTelegramUsername(cfg.username || cfg.channel || cfg.url || source.name);
  if (!username) throw new Error('Telegram channel username is missing');
  const pageUrl = `https://t.me/s/${encodeURIComponent(username)}`;
  const html = await fetchText(pageUrl);
  const items = [];
  const wrapRe = /<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?(?=<div class="tgme_widget_message_wrap[^"]*"|<div class="tgme_widget_message_centered|<\/section>|$)/g;
  let m;
  while ((m = wrapRe.exec(html)) !== null) {
    const block = m[0];
    const postMatch = block.match(/data-post="([^"]+)"/);
    const dateMatch = block.match(/<a class="tgme_widget_message_date"[^>]*href="([^"]+)"[\s\S]*?<time[^>]*datetime="([^"]+)"/);
    let link = dateMatch ? dateMatch[1] : (postMatch ? `https://t.me/${postMatch[1]}` : null);
    if (!link) continue;
    if (link.startsWith('/')) link = 'https://t.me' + link;
    const publishedAt = parseDate(dateMatch ? dateMatch[2] : null);
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_footer|<div class="tgme_widget_message_photo|<a class="tgme_widget_message_link_preview|<div class="tgme_widget_message_poll|$)/);
    const rawText = textMatch ? textMatch[1] : '';
    const title = cleanTitle(rawText, `پست کانال ${username}`);
    items.push({ title, link, published_at: publishedAt || nowIso() });
  }
  return dedupeItems(items).slice(0, 50);
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function extractAtomLink(entry) {
  const m1 = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i);
  if (m1) return decodeEntities(m1[1]);
  const m2 = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>(?:<\/link>)?/i);
  if (m2) return decodeEntities(m2[1]);
  const m3 = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/i);
  if (m3) return decodeEntities(m3[1]);
  return '';
}

function parseFeed(xml) {
  const items = [];
  // RSS items
  const rssRe = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = rssRe.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, 'title');
    let link = extractTag(block, 'link');
    if (!link) {
      const gm = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
      if (gm && /https?:/i.test(gm[1])) link = gm[1].trim();
    }
    const pub = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published') || extractTag(block, 'updated');
    if (link) items.push({ title: cleanTitle(title, 'خبر بدون عنوان'), link: decodeEntities(link), published_at: parseDate(pub) || nowIso() });
  }
  if (items.length) return items;
  // Atom entries
  const atomRe = /<entry\b[\s\S]*?<\/entry>/gi;
  while ((m = atomRe.exec(xml)) !== null) {
    const block = m[0];
    const title = extractTag(block, 'title');
    const link = extractAtomLink(block);
    const pub = extractTag(block, 'published') || extractTag(block, 'updated');
    if (link) items.push({ title: cleanTitle(title, 'خبر بدون عنوان'), link, published_at: parseDate(pub) || nowIso() });
  }
  return items;
}

async function resolveYoutubeFeedUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('YouTube source is empty');
  if (/feeds\/videos\.xml/i.test(s)) return s;
  const idMatch = s.match(/[?&]channel_id=(UC[\w-]+)/i) || s.match(/youtube\.com\/channel\/(UC[\w-]+)/i);
  if (idMatch) return `https://www.youtube.com/feeds/videos.xml?channel_id=${idMatch[1]}`;

  let pageUrl = s;
  if (/^UC[\w-]+$/.test(s)) return `https://www.youtube.com/feeds/videos.xml?channel_id=${s}`;
  if (s.startsWith('@')) pageUrl = `https://www.youtube.com/${s}`;
  else if (!/^https?:\/\//i.test(s)) pageUrl = `https://www.youtube.com/@${s.replace(/^@/, '')}`;

  const html = await fetchText(pageUrl);
  const rssMatch = html.match(/<link[^>]+type=["']application\/rss\+xml["'][^>]+href=["']([^"']+)["']/i) || html.match(/"rssUrl":"([^"]+)"/i);
  if (rssMatch) return decodeEntities(rssMatch[1]).replace(/\\u0026/g, '&');
  const cidMatch = html.match(/"channelId":"(UC[\w-]+)"/) || html.match(/<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[\w-]+)["']/i) || html.match(/channel_id=(UC[\w-]+)/i);
  if (cidMatch) return `https://www.youtube.com/feeds/videos.xml?channel_id=${cidMatch[1]}`;
  throw new Error('Could not resolve YouTube channel/feed URL');
}

async function fetchYoutube(source) {
  const cfg = safeJson(source.config);
  const feedUrl = await resolveYoutubeFeedUrl(cfg.url || cfg.channel || cfg.handle || source.name);
  const xml = await fetchText(feedUrl);
  return dedupeItems(parseFeed(xml)).slice(0, 50);
}

async function fetchRss(source) {
  const cfg = safeJson(source.config);
  const url = String(cfg.url || '').trim();
  if (!url) throw new Error('RSS URL is missing');
  const xml = await fetchText(url);
  return dedupeItems(parseFeed(xml)).slice(0, 100);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !it.link) continue;
    const key = it.link.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function safeJson(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

async function fetchSourceItems(source) {
  switch (source.type) {
    case 'telegram': return await fetchTelegram(source);
    case 'youtube': return await fetchYoutube(source);
    case 'rss': return await fetchRss(source);
    default: throw new Error(`Unknown source type: ${source.type}`);
  }
}

async function syncSource(source) {
  const started = Date.now();
  let fetched = 0, inserted = 0, error = null;
  try {
    const items = await fetchSourceItems(source);
    fetched = items.length;
    const t = nowIso();
    for (const item of items) {
      const res = await pool.query(
        `INSERT INTO news (source_id, source_name, source_type, title, link, published_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (link) DO NOTHING`,
        [source.id, source.name, source.type, item.title, item.link, item.published_at || t, t]
      );
      if (res.rowCount > 0) inserted += res.rowCount;
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  return { sourceId: source.id, name: source.name, fetched, inserted, ms: Date.now() - started, error };
}

async function syncAllSources() {
  const { rows: sources } = await pool.query('SELECT * FROM sources WHERE enabled = TRUE ORDER BY id');
  const results = [];
  for (const s of sources) {
    results.push(await syncSource(s));
  }
  return { at: nowIso(), results };
}

let syncing = false;
async function guardedSyncAll() {
  if (syncing) return { at: nowIso(), results: [], skipped: true };
  syncing = true;
  try {
    const out = await syncAllSources();
    console.log(`[fetch] ${out.at} -`, out.results.map(r => `${r.name}:${r.inserted}/${r.fetched}${r.error ? '!' : ''}`).join(', '));
    return out;
  } finally {
    syncing = false;
  }
}

async function getFolders() {
  const { rows } = await pool.query('SELECT * FROM folders ORDER BY created_at ASC, id ASC');
  return rows;
}

async function getSources() {
  const { rows } = await pool.query('SELECT * FROM sources ORDER BY created_at DESC, id DESC');
  return rows;
}

async function getSourceById(id) {
  const { rows } = await pool.query('SELECT * FROM sources WHERE id = $1', [id]);
  return rows[0] || null;
}

async function normalizeSourceIds(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') {
    try { arr = JSON.parse(input); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const unique = [...new Set(arr.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0))];
  if (!unique.length) return [];
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(`SELECT id FROM sources WHERE id IN (${placeholders})`, unique);
  const existing = new Set(rows.map(r => r.id));
  return unique.filter(id => existing.has(id));
}

function parseFolderSourceIds(folder) {
  const raw = folder && folder.source_ids;
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0);
}

function parseFolderKeywords(folder) {
  return String((folder && folder.keywords) || '')
    .split(/[\n,]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function matchFolder(newsRow, folder) {
  const sourceIds = parseFolderSourceIds(folder);
  const kws = parseFolderKeywords(folder);
  const hasSourceFilter = sourceIds.length > 0;
  const hasKeywordFilter = kws.length > 0;

  if (!hasSourceFilter && !hasKeywordFilter) return false;

  let bySource = false;
  if (hasSourceFilter) {
    bySource = newsRow.source_id != null && sourceIds.includes(Number(newsRow.source_id));
  }

  let byKeyword = false;
  if (hasKeywordFilter) {
    const title = String(newsRow.title || '').toLowerCase();
    byKeyword = kws.some(k => title.includes(k));
  }

  if (hasSourceFilter && hasKeywordFilter) return bySource || byKeyword;
  return hasSourceFilter ? bySource : byKeyword;
}

async function queryNews(params) {
  const limit = Math.min(Math.max(parseInt(params.limit || '200', 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(params.offset || '0', 10) || 0, 0);
  const pinnedOnly = params.pinned === '1' || params.pinned === 'true';
  const folderId = params.folder_id ? parseInt(params.folder_id, 10) : null;
  const search = String(params.q || '').trim().toLowerCase();

  const { rows } = await pool.query(`
    SELECT
      n.id, n.source_id, n.title, n.link, n.published_at, n.fetched_at, n.pinned,
      COALESCE(NULLIF(n.source_name, ''), s.name) AS source_name,
      COALESCE(NULLIF(n.source_type, ''), s.type) AS source_type
    FROM news n
    LEFT JOIN sources s ON s.id = n.source_id
    ORDER BY COALESCE(n.published_at, n.fetched_at) DESC, n.id DESC
  `);

  let filtered = rows;
  if (pinnedOnly) filtered = filtered.filter(r => r.pinned);
  if (search) filtered = filtered.filter(r => (r.title || '').toLowerCase().includes(search) || (r.source_name || '').toLowerCase().includes(search));

  if (folderId) {
    const folder = await getFolderById(folderId);
    if (!folder) return { items: [], total: 0, folder: null };
    filtered = filtered.filter(r => matchFolder(r, folder));
    const total = filtered.length;
    return { items: filtered.slice(offset, offset + limit), total, folder };
  }

  const total = filtered.length;
  return { items: filtered.slice(offset, offset + limit), total };
}

async function getFolderById(id) {
  const { rows } = await pool.query('SELECT * FROM folders WHERE id = $1', [id]);
  return rows[0] || null;
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'hooshlive', time: nowIso() });
    }

    if (method === 'GET' && pathname === '/api/sources') {
      return sendJson(res, 200, { sources: await getSources() });
    }

    if (method === 'POST' && pathname === '/api/sources') {
      const body = await readJson(req);
      const type = String(body.type || '').trim();
      const name = String(body.name || '').trim();
      const config = body.config && typeof body.config === 'object' ? body.config : {};
      if (!['telegram', 'youtube', 'rss'].includes(type)) return sendJson(res, 400, { error: 'نوع منبع نامعتبر است' });
      if (!name) return sendJson(res, 400, { error: 'نام منبع الزامی است' });
      if (type === 'telegram' && !config.username && !config.url) return sendJson(res, 400, { error: 'نام کاربری یا لینک کانال تلگرام الزامی است' });
      if (type === 'youtube' && !config.url && !config.channel && !config.handle) return sendJson(res, 400, { error: 'لینک/شناسه کانال یوتیوب الزامی است' });
      if (type === 'rss' && !config.url) return sendJson(res, 400, { error: 'آدرس فید RSS الزامی است' });
      const { rows } = await pool.query(
        'INSERT INTO sources (type, name, config, enabled) VALUES ($1, $2, $3, TRUE) RETURNING *',
        [type, name, JSON.stringify(config)]
      );
      const source = rows[0];
      // initial fetch in background
      syncSource(source).then(r => console.log('[fetch:new]', r)).catch(() => {});
      return sendJson(res, 201, { source });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/sources/')) {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!id) return sendJson(res, 400, { error: 'Invalid id' });
      await pool.query('DELETE FROM sources WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && /^\/api\/sources\/\d+\/toggle$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const enabled = !!body.enabled;
      await pool.query('UPDATE sources SET enabled = $1 WHERE id = $2', [enabled, id]);
      return sendJson(res, 200, { source: await getSourceById(id) });
    }

    if (method === 'POST' && /^\/api\/sources\/\d+\/fetch$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const source = await getSourceById(id);
      if (!source) return sendJson(res, 404, { error: 'منبع پیدا نشد' });
      const result = await syncSource(source);
      return sendJson(res, 200, { result });
    }

    if (method === 'POST' && pathname === '/api/fetch') {
      const result = await guardedSyncAll();
      return sendJson(res, 200, result);
    }

    if (method === 'GET' && pathname === '/api/news') {
      const data = await queryNews(Object.fromEntries(searchParams.entries()));
      return sendJson(res, 200, data);
    }

    if (method === 'POST' && /^\/api\/news\/\d+\/pin$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const pinned = !!body.pinned;
      await pool.query('UPDATE news SET pinned = $1 WHERE id = $2', [pinned, id]);
      const item = await pool.query(
        `SELECT
           n.id, n.source_id, n.title, n.link, n.published_at, n.fetched_at, n.pinned,
           COALESCE(NULLIF(n.source_name, ''), s.name) AS source_name,
           COALESCE(NULLIF(n.source_type, ''), s.type) AS source_type
         FROM news n
         LEFT JOIN sources s ON s.id = n.source_id
         WHERE n.id = $1`,
        [id]
      ).then(r => r.rows[0] || null);
      return sendJson(res, 200, { item });
    }

    if (method === 'GET' && pathname === '/api/folders') {
      return sendJson(res, 200, { folders: await getFolders() });
    }

    if (method === 'POST' && pathname === '/api/folders') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      let keywords = String(body.keywords || '').trim();
      const rawSourceIds = body.source_ids;
      const sourceIds = await normalizeSourceIds(rawSourceIds);
      console.log('[folders:create]', { name, keywords, rawSourceIds, sourceIds });
      if (!name) return sendJson(res, 400, { error: 'نام پوشه الزامی است' });
      if (!keywords && sourceIds.length === 0) keywords = name; // default filter
      const { rows } = await pool.query(
        'INSERT INTO folders (name, keywords, source_ids) VALUES ($1, $2, $3) RETURNING *',
        [name, keywords, JSON.stringify(sourceIds)]
      );
      return sendJson(res, 201, { folder: rows[0] });
    }

    if (method === 'PUT' && /^\/api\/folders\/\d+$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      let keywords = String(body.keywords || '').trim();
      const rawSourceIds = body.source_ids;
      const sourceIds = await normalizeSourceIds(rawSourceIds);
      console.log('[folders:update]', { id, name, keywords, rawSourceIds, sourceIds });
      if (!name) return sendJson(res, 400, { error: 'نام پوشه الزامی است' });
      if (!keywords && sourceIds.length === 0) keywords = name;
      await pool.query(
        'UPDATE folders SET name = $1, keywords = $2, source_ids = $3 WHERE id = $4',
        [name, keywords, JSON.stringify(sourceIds), id]
      );
      const folder = await getFolderById(id);
      return sendJson(res, 200, { folder });
    }

    if (method === 'DELETE' && /^\/api\/folders\/\d+$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      await pool.query('DELETE FROM folders WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const status = /Invalid JSON|نامعتبر|الزامی/.test(msg) ? 400 : 500;
    return sendJson(res, status, { error: msg });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(urlObj.pathname);
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, urlObj);
    }
    if (serveStatic(req, res, pathname)) return;
    // SPA fallback
    if (serveStatic(req, res, '/')) return;
    sendText(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
  }
});

(async () => {
  try {
    await initDb();
    server.listen(PORT, () => {
      console.log(`hooshlive running at http://localhost:${PORT}`);
      // initial sync shortly after start
      setTimeout(() => { guardedSyncAll().catch(err => console.error('[fetch:init]', err)); }, 1500);
      setInterval(() => { guardedSyncAll().catch(err => console.error('[fetch:interval]', err)); }, FETCH_INTERVAL_MS);
    });
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
})();
