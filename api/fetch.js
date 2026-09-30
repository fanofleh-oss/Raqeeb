const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

function isPrivateIp(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224;
  }
  const ip = address.toLowerCase();
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') ||
    ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') ||
    ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
}

async function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('الرابط غير صالح.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('يُسمح بروابط HTTP وHTTPS فقط.');
  if (url.username || url.password) throw new Error('الرابط الذي يتضمن بيانات دخول غير مسموح.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('هذا العنوان غير مسموح.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateIp(record.address))) throw new Error('هذا العنوان غير مسموح.');
  return url;
}

function decodeHtml(value = '') {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»' };
  return String(value).replace(/&#(\d+);?/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m)
    .replace(/\u00a0/g, ' ');
}

function textOnly(value = '') {
  return decodeHtml(String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function meta(html, ...keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return textOnly(match[1]);
    }
  }
  return '';
}

function jsonLdArticles(html) {
  const values = [];
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]).replace(/^\s*<!--|-->\s*$/g, ''));
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        const type = Array.isArray(item['@type']) ? item['@type'].join(' ') : String(item['@type'] || '');
        if (/Article|NewsArticle|ReportageNewsArticle|BlogPosting/i.test(type) || item.articleBody) values.push(item);
      }
    } catch {}
  }
  return values.sort((a, b) => String(b.articleBody || '').length - String(a.articleBody || '').length);
}

function personName(value) {
  if (Array.isArray(value)) return value.map(personName).filter(Boolean).join(', ');
  if (value && typeof value === 'object') return textOnly(value.name || '');
  return textOnly(value || '');
}

function extractBody(html, article) {
  if (article?.articleBody && textOnly(article.articleBody).length >= 120) return textOnly(article.articleBody);
  let clean = html.replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const region = clean.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || clean;
  const blocks = [];
  for (const match of region.matchAll(/<(p|h2|h3|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = textOnly(match[2]);
    if (text.length >= 25 && !/^(advertisement|إعلان|اقرأ أيضًا|read also|related articles)$/i.test(text)) blocks.push(text);
  }
  return [...new Set(blocks)].join('\n\n').slice(0, 100000);
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

async function readLimited(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error('حجم الصفحة أكبر من الحد المسموح.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new Error('حجم الصفحة أكبر من الحد المسموح.'); }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(merged);
}

async function fetchPage(input, redirects = 0) {
  const url = await validateUrl(input);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'RAQEEB-Article-Extractor/1.0 (+https://raqeeb-one.vercel.app/)',
      'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8',
      'Accept-Language': 'ar,en;q=0.8'
    }
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error('عدد تحويلات الرابط أكبر من المسموح.');
    const location = response.headers.get('location');
    if (!location) throw new Error('تعذر متابعة تحويل الرابط.');
    return fetchPage(new URL(location, url).href, redirects + 1);
  }
  if (!response.ok) throw new Error(`تعذر تحميل الصفحة (HTTP ${response.status}).`);
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) {
    throw new Error('الرابط لا يشير إلى صفحة مقال نصية.');
  }
  return { url: response.url || url.href, html: await readLimited(response), type };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const input = String(req.body?.url || '').trim().slice(0, 2000);
  if (!input) return res.status(400).json({ error: 'أدخل رابط المقال أولًا.' });
  try {
    const page = await fetchPage(input);
    if (page.type.includes('text/plain')) {
      const text = page.html.trim().slice(0, 100000);
      if (text.length < 80) throw new Error('لم يُعثر على نص كافٍ في الرابط.');
      return res.status(200).json({ url: page.url, title: new URL(page.url).hostname, publisher: new URL(page.url).hostname, author: '', date: '', text });
    }
    const article = jsonLdArticles(page.html)[0] || {};
    const title = textOnly(article.headline || meta(page.html, 'og:title', 'twitter:title') || page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const publisher = personName(article.publisher) || meta(page.html, 'og:site_name', 'application-name') || new URL(page.url).hostname.replace(/^www\./, '');
    const author = personName(article.author) || meta(page.html, 'author', 'article:author', 'byl');
    const date = normalizeDate(article.datePublished || meta(page.html, 'article:published_time', 'datePublished', 'date'));
    const text = extractBody(page.html, article);
    if (text.length < 120) throw new Error('تعذّر استخراج نص كافٍ من الصفحة. الصق النص يدويًا أو جرّب رابط الطباعة.');
    return res.status(200).json({ url: page.url, title: title.slice(0, 300) || publisher, publisher: publisher.slice(0, 200), author: author.slice(0, 200), date, text });
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'انتهت مهلة جلب الصفحة.' : (error?.message || 'تعذر جلب المقال.');
    return res.status(422).json({ error: message });
  }
};
