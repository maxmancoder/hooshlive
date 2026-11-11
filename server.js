const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'hooshlive.db');
const PORT = Number(process.env.PORT) || 3000;
const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER,
  title TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  pinned INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_published ON news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_source ON news(source_id);
CREATE INDEX IF NOT EXISTS idx_news_pinned ON news(pinned);
`);

// Migration: add source_ids to folders for existing databases
try {
  db.exec("ALTER TABLE folders ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]'");
} catch (_) {
  // column already exists
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

const insertNewsStmt = () => db.prepare(`
  INSERT INTO news (source_id, title, link, published_at, fetched_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(link) DO NOTHING
`);

async function syncSource(source) {
  const started = Date.now();
  let fetched = 0, inserted = 0, error = null;
  try {
    const items = await fetchSourceItems(source);
    fetched = items.length;
    const stmt = insertNewsStmt();
    const t = nowIso();
    for (const item of items) {
      const info = stmt.run(source.id, item.title, item.link, item.published_at || t, t);
      if (info.changes > 0) inserted += Number(info.changes);
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  return { sourceId: source.id, name: source.name, fetched, inserted, ms: Date.now() - started, error };
}

async function syncAllSources() {
  const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY id').all();
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

function getFolders() {
  return db.prepare('SELECT * FROM folders ORDER BY created_at ASC, id ASC').all();
}

function getSources() {
  return db.prepare('SELECT * FROM sources ORDER BY created_at DESC, id DESC').all();
}

function getSourceById(id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

function normalizeSourceIds(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') {
    try { arr = JSON.parse(input); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  const unique = [...new Set(arr.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x > 0))];
  if (!unique.length) return [];
  // keep only existing source IDs
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM sources WHERE id IN (${placeholders})`).all(...unique);
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

function queryNews(params) {
  const limit = Math.min(Math.max(parseInt(params.limit || '200', 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(params.offset || '0', 10) || 0, 0);
  const pinnedOnly = params.pinned === '1' || params.pinned === 'true';
  const folderId = params.folder_id ? parseInt(params.folder_id, 10) : null;
  const search = String(params.q || '').trim().toLowerCase();

  let rows = db.prepare(`
    SELECT n.*, s.name AS source_name, s.type AS source_type
    FROM news n
    LEFT JOIN sources s ON s.id = n.source_id
    ORDER BY COALESCE(n.published_at, n.fetched_at) DESC, n.id DESC
  `).all();

  if (pinnedOnly) rows = rows.filter(r => r.pinned);
  if (search) rows = rows.filter(r => (r.title || '').toLowerCase().includes(search) || (r.source_name || '').toLowerCase().includes(search));

  if (folderId) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder) return { items: [], total: 0, folder: null };
    rows = rows.filter(r => matchFolder(r, folder));
    const total = rows.length;
    return { items: rows.slice(offset, offset + limit), total, folder };
  }

  const total = rows.length;
  return { items: rows.slice(offset, offset + limit), total };
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'hooshlive', time: nowIso() });
    }

    if (method === 'GET' && pathname === '/api/sources') {
      return sendJson(res, 200, { sources: getSources() });
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
      const info = db.prepare('INSERT INTO sources (type, name, config, enabled) VALUES (?, ?, ?, 1)').run(type, name, JSON.stringify(config));
      const source = getSourceById(info.lastInsertRowid);
      // initial fetch in background
      syncSource(source).then(r => console.log('[fetch:new]', r)).catch(() => {});
      return sendJson(res, 201, { source });
    }

    if (method === 'DELETE' && pathname.startsWith('/api/sources/')) {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!id) return sendJson(res, 400, { error: 'Invalid id' });
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && /^\/api\/sources\/\d+\/toggle$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const enabled = body.enabled ? 1 : 0;
      db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled, id);
      return sendJson(res, 200, { source: getSourceById(id) });
    }

    if (method === 'POST' && /^\/api\/sources\/\d+\/fetch$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const source = getSourceById(id);
      if (!source) return sendJson(res, 404, { error: 'منبع پیدا نشد' });
      const result = await syncSource(source);
      return sendJson(res, 200, { result });
    }

    if (method === 'POST' && pathname === '/api/fetch') {
      const result = await guardedSyncAll();
      return sendJson(res, 200, result);
    }

    if (method === 'GET' && pathname === '/api/news') {
      const data = queryNews(Object.fromEntries(searchParams.entries()));
      return sendJson(res, 200, data);
    }

    if (method === 'POST' && /^\/api\/news\/\d+\/pin$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const pinned = body.pinned ? 1 : 0;
      db.prepare('UPDATE news SET pinned = ? WHERE id = ?').run(pinned, id);
      const item = db.prepare('SELECT n.*, s.name AS source_name, s.type AS source_type FROM news n LEFT JOIN sources s ON s.id=n.source_id WHERE n.id=?').get(id);
      return sendJson(res, 200, { item });
    }

    if (method === 'GET' && pathname === '/api/folders') {
      return sendJson(res, 200, { folders: getFolders() });
    }

    if (method === 'POST' && pathname === '/api/folders') {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      let keywords = String(body.keywords || '').trim();
      const rawSourceIds = body.source_ids;
      const sourceIds = normalizeSourceIds(rawSourceIds);
      console.log('[folders:create]', { name, keywords, rawSourceIds, sourceIds });
      if (!name) return sendJson(res, 400, { error: 'نام پوشه الزامی است' });
      if (!keywords && sourceIds.length === 0) keywords = name; // default filter
      const info = db.prepare('INSERT INTO folders (name, keywords, source_ids) VALUES (?, ?, ?)').run(name, keywords, JSON.stringify(sourceIds));
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(info.lastInsertRowid);
      return sendJson(res, 201, { folder });
    }

    if (method === 'PUT' && /^\/api\/folders\/\d+$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      let keywords = String(body.keywords || '').trim();
      const rawSourceIds = body.source_ids;
      const sourceIds = normalizeSourceIds(rawSourceIds);
      console.log('[folders:update]', { id, name, keywords, rawSourceIds, sourceIds });
      if (!name) return sendJson(res, 400, { error: 'نام پوشه الزامی است' });
      if (!keywords && sourceIds.length === 0) keywords = name;
      db.prepare('UPDATE folders SET name = ?, keywords = ?, source_ids = ? WHERE id = ?').run(name, keywords, JSON.stringify(sourceIds), id);
      const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
      return sendJson(res, 200, { folder });
    }

    if (method === 'DELETE' && /^\/api\/folders\/\d+$/.test(pathname)) {
      const id = parseInt(pathname.split('/')[3], 10);
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
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

server.listen(PORT, () => {
  console.log(`hooshlive running at http://localhost:${PORT}`);
  // initial sync shortly after start
  setTimeout(() => { guardedSyncAll().catch(err => console.error('[fetch:init]', err)); }, 1500);
  setInterval(() => { guardedSyncAll().catch(err => console.error('[fetch:interval]', err)); }, FETCH_INTERVAL_MS);
});
