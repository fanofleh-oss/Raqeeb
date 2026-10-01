const dns = require('node:dns').promises;
const net = require('node:net');

function clean(value, max = 1000) { return String(value || '').trim().slice(0, max); }
function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const p = address.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  const ip = String(address || '').toLowerCase();
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip);
}
async function safeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('رابط المزود غير صالح.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('رابط المزود يجب أن يكون HTTPS.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('عنوان المزود غير مسموح.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateIp(record.address))) throw new Error('عنوان المزود غير مسموح.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = clean(req.body?.apiKey, 500), provider = clean(req.body?.provider, 40);
  if (apiKey.length < 12) return res.status(401).json({ error: 'أدخل مفتاح API صالحًا.' });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    let endpoint, headers = { Accept: 'application/json' }, label;
    if (provider === 'gemini') {
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      label = 'Google Gemini';
    } else {
      const known = {
        openai: ['https://api.openai.com/v1', 'OpenAI'],
        huggingface: ['https://router.huggingface.co/v1', 'Hugging Face'],
        groq: ['https://api.groq.com/openai/v1', 'Groq']
      }[provider];
      const base = known?.[0] || await safeBaseUrl(clean(req.body?.baseUrl));
      label = known?.[1] || new URL(base).hostname;
      endpoint = `${base}/models`;
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: raw?.error?.message || raw?.message || `تعذر التحقق من ${label}.` });
    let models;
    if (provider === 'gemini') models = (raw.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name || '').replace(/^models\//, ''));
    else models = (raw.data || raw.models || []).map(m => typeof m === 'string' ? m : m?.id).filter(Boolean);
    models = [...new Set(models)].filter(id => /^[a-zA-Z0-9._:/-]+$/.test(id)).sort().slice(0, 300);
    return res.status(200).json({ ok: true, provider: label, models });
  } catch (error) {
    return res.status(error.name === 'AbortError' ? 504 : 502).json({ error: error.name === 'AbortError' ? 'انتهت مهلة اختبار الاتصال.' : (error.message || 'تعذر اختبار الاتصال.') });
  } finally { clearTimeout(timer); }
};
