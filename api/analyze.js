const crypto = require('node:crypto');

const VALID_STATUSES = new Set(['unassessed', 'supported', 'mixed', 'not_observed', 'insufficient', 'not_applicable']);
const schema = {
  type: 'object',
  required: ['summary', 'claims', 'scenarios', 'limitations', 'reviews'],
  properties: {
    summary: { type: 'string' },
    claims: { type: 'array', items: { type: 'object', required: ['claim', 'verdict', 'reason', 'source_ids'], properties: {
      claim: { type: 'string' }, verdict: { type: 'string' }, reason: { type: 'string' }, source_ids: { type: 'array', items: { type: 'string' } }
    } } },
    scenarios: { type: 'array', items: { type: 'object', required: ['name', 'assessment', 'support', 'against', 'trigger'], properties: {
      name: { type: 'string' }, assessment: { type: 'string' }, support: { type: 'string' }, against: { type: 'string' }, trigger: { type: 'string' }
    } } },
    limitations: { type: 'array', items: { type: 'string' } },
    reviews: { type: 'array', items: { type: 'object', required: ['id', 'status', 'confidence', 'source_id', 'quote', 'observation', 'alternative', 'next_step'], properties: {
      id: { type: 'string' }, status: { type: 'string' }, confidence: { type: 'string' }, source_id: { type: 'string' }, quote: { type: 'string' }, observation: { type: 'string' }, alternative: { type: 'string' }, next_step: { type: 'string' }
    } } }
  }
};

function cleanText(value, max = 5000) { return String(value || '').trim().slice(0, max); }

function buildPrompt(caseFile, language, sources) {
  const sourceBlock = sources.map((s, i) => `\n--- SOURCE ${i + 1} ---\nID: ${s.id}\nTitle: ${s.title}\nPublisher: ${s.publisher || 'unknown'}\nAuthor: ${s.author || 'unknown'}\nDate: ${s.date || 'unknown'}\nShared origin: ${s.origin || 'not supplied'}\nURL: ${s.url || 'not supplied'}\nNotes: ${s.notes || 'none'}\nTEXT:\n${s.text}`).join('\n');
  return `You are RAQEEB, an evidence-first verification analyst. Produce a detailed report in ${language}.

INVESTIGATION
Title: ${cleanText(caseFile.title, 300)}
Question: ${cleanText(caseFile.question, 1000)}
Time horizon: ${cleanText(caseFile.horizon, 200) || 'not specified'}

NON-NEGOTIABLE RULES
1. Analyze only the supplied material. Never invent a source, fact, date, quotation, or certainty.
2. Separate observable facts, attributed statements, inference, prediction, and unknowns.
3. A repeated article with the same origin is one origin, not independent corroboration.
4. Every source_id must exactly match an ID below. A quote must be copied exactly from that source text. Use an empty quote/source_id when no direct textual evidence exists.
5. State evidence against each important claim, plausible alternative explanations, missing evidence, and the next verification step.
6. Do not output a numerical truth score. Use calibrated language and explain confidence.
7. Cover the central claims in depth, but avoid repetition. Flag internal contradictions and chronology problems.
8. The 45 review IDs are 1.1–9.5. Include all 45. Status must be one of: supported, mixed, not_observed, insufficient, not_applicable. Confidence must be low, medium, or high.
9. 'not_observed' means the indicator was actively checked and absent within the supplied scope; 'insufficient' means the supplied material cannot support the check.

For claims, use clear editorial verdicts such as supported, contradicted, partly supported, attributed only, or insufficient evidence, followed by a concrete reason. For scenarios, do not assign probabilities unless the evidence permits it; give support, counter-evidence, and a discriminating future trigger.

SUPPLIED SOURCES
${sourceBlock}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = cleanText(req.body?.geminiKey, 300);
  if (apiKey.length < 20) return res.status(401).json({ error: 'مفتاح Gemini مفقود أو غير صالح.' });
  const caseFile = req.body?.case;
  if (!caseFile || !Array.isArray(caseFile.sources) || !caseFile.sources.length) return res.status(400).json({ error: 'أضف مصدرًا واحدًا على الأقل.' });
  if (caseFile.sources.length > 12) return res.status(400).json({ error: 'الحد الأقصى 12 مصدرًا في العملية الواحدة.' });
  const requestedTotal = caseFile.sources.reduce((sum, s) => sum + String(s?.text || '').length, 0);
  if (requestedTotal > 60000) return res.status(400).json({ error: 'حجم نصوص المصادر يتجاوز 60,000 حرف.' });
  let total = 0;
  const sources = caseFile.sources.map(s => {
    const text = cleanText(s.text, 60000 - total);
    total += text.length;
    return { id: cleanText(s.id, 100), title: cleanText(s.title, 300), publisher: cleanText(s.publisher, 200), author: cleanText(s.author, 200), date: cleanText(s.date, 40), origin: cleanText(s.origin, 200), url: cleanText(s.url, 1000), notes: cleanText(s.notes, 1000), text };
  }).filter(s => s.id && s.text);
  if (!sources.length) return res.status(400).json({ error: 'لا توجد نصوص مصادر صالحة للتحليل.' });

  const requestedModel = cleanText(req.body?.model, 100);
  const model = /^[a-zA-Z0-9._-]+$/.test(requestedModel) ? requestedModel : (process.env.GEMINI_MODEL || 'gemini-2.5-flash');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(caseFile, cleanText(req.body.language, 80) || 'Arabic', sources) }] }],
        generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseSchema: schema }
      })
    });
    const raw = await response.json();
    if (!response.ok) return res.status(502).json({ error: raw?.error?.message || 'فشل اتصال Gemini.' });
    const text = raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { return res.status(502).json({ error: 'أعاد Gemini نتيجة غير قابلة للقراءة. أعد المحاولة.' }); }
    const sourceMap = new Map(sources.map(s => [s.id, s]));
    const reviews = {};
    for (const item of Array.isArray(parsed.reviews) ? parsed.reviews : []) {
      if (!/^([1-9])\.[1-5]$/.test(item.id || '')) continue;
      const source = sourceMap.get(item.source_id);
      const quote = cleanText(item.quote, 1500);
      reviews[item.id] = {
        id: item.id,
        status: VALID_STATUSES.has(item.status) ? item.status : 'insufficient',
        confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'low',
        source_id: source ? item.source_id : '', quote: source ? quote : '', quote_match: Boolean(source && quote && source.text.includes(quote)),
        observation: cleanText(item.observation, 3000), alternative: cleanText(item.alternative, 2000), next_step: cleanText(item.next_step, 2000), author: 'Google Gemini'
      };
    }
    for (let axis = 1; axis <= 9; axis++) for (let q = 1; q <= 5; q++) {
      const id = `${axis}.${q}`;
      if (!reviews[id]) reviews[id] = { id, status: 'insufficient', confidence: 'low', source_id: '', quote: '', quote_match: false, observation: 'لم يُنتج النموذج تقييمًا موثقًا لهذا البند.', alternative: '', next_step: 'مراجعة بشرية مطلوبة.', author: 'RAQEEB validation' };
    }
    const validIds = new Set(sources.map(s => s.id));
    const claims = (Array.isArray(parsed.claims) ? parsed.claims : []).slice(0, 20).map(c => ({ claim: cleanText(c.claim, 1200), verdict: cleanText(c.verdict, 300), reason: cleanText(c.reason, 2500), source_ids: (Array.isArray(c.source_ids) ? c.source_ids : []).filter(id => validIds.has(id)) }));
    const scenarios = (Array.isArray(parsed.scenarios) ? parsed.scenarios : []).slice(0, 8).map(s => ({ name: cleanText(s.name, 300), assessment: cleanText(s.assessment, 1500), support: cleanText(s.support, 2000), against: cleanText(s.against, 2000), trigger: cleanText(s.trigger, 2000) }));
    return res.status(200).json({
      id: crypto.randomUUID(), created: new Date().toISOString(), mode: 'ai', provider: 'Google Gemini', model, methodology: '0.2', language: cleanText(req.body.language, 80) || 'Arabic',
      summary: cleanText(parsed.summary, 8000), claims, scenarios, limitations: (Array.isArray(parsed.limitations) ? parsed.limitations : []).slice(0, 20).map(v => cleanText(v, 1500)),
      reviews, sources: caseFile.sources, changes: '', usage: { input_tokens: raw.usageMetadata?.promptTokenCount || null, output_tokens: raw.usageMetadata?.candidatesTokenCount || null }
    });
  } catch (error) {
    return res.status(error.name === 'AbortError' ? 504 : 502).json({ error: error.name === 'AbortError' ? 'انتهت مهلة التحليل. قلّل حجم المصادر وحاول مجددًا.' : 'تعذر الاتصال بخدمة Gemini.' });
  } finally { clearTimeout(timer); }
};
