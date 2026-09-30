const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const VALID_STATUSES = new Set(['unassessed', 'supported', 'mixed', 'not_observed', 'insufficient', 'not_applicable']);
const RUBRIC = [
  ['التحكم بالانتباه','corpus',['هل يتم توجيه التركيز العام نحو قضية واحدة بشكل مبالغ فيه؟','هل توجد ملفات موازية يتم تهميشها أو تجاهلها؟','هل حدث صمت مفاجئ حول موضوع كان حاضرًا سابقًا؟','ما الذي اختفى من المشهد فجأة؟','هل يخدم هذا التركيز عملية إخفاء نشاط آخر؟']],
  ['الإغراق المعلوماتي','corpus',['هل يتم ضخ عدد كبير من الأخبار دون تطور نوعي حقيقي؟','هل الأخبار متشابهة في الصياغة والمضمون؟','هل تتكرر المصطلحات ذاتها دون إضافة معلومات جديدة؟','هل هناك تقدم فعلي أم مجرد إعادة تدوير للمحتوى؟','هل الكم يغطي على غياب الدليل القوي؟']],
  ['المصدر المجهول / غير القابل للتحقق','text',['هل تعتمد الرواية على مصادر مطلعة غير محددة؟','هل يتم الاستناد إلى دوائر قريبة أو أطراف ثالثة غامضة؟','هل يمكن مساءلة المصدر أو التحقق منه؟','من المستفيد من الغموض، وما الدليل الذي يربطه به؟','هل يتم خلق سلطة معرفية دون قابلية للفحص؟']],
  ['التوقيت مع ضغط القرار','context',['هل جاء التسريب أو الخبر قبيل قرار سياسي أو عسكري مهم؟','هل ظهر الخبر عند ذروة توتر أو أزمة؟','لماذا الآن تحديدًا؟','هل يضغط التوقيت على متخذ القرار؟','هل يمكن فصل زمن التحليل عن زمن القرار؟']],
  ['التماسك السردي المفرط','text',['هل الرواية مكتملة بشكل مريح أكثر من اللازم؟','هل تغيب الفجوات أو مناطق الغموض الطبيعية؟','هل تقدم إجابات جاهزة لكل سؤال محتمل؟','أين التناقض الطبيعي في الرواية؟','هل هذا التماسك يخدم منع التساؤل النقدي؟']],
  ['تضخيم أو تقليل التهديد','context',['هل الخطاب التهديدي مفرط مقارنة بالفعل؟','هل توجد تحركات رمزية أكثر من كونها عملياتية؟','هل الفعل يوازي الخطاب؟','هل توجد أدلة على محاولة دفع الخصم لرد فعل غير متوازن؟','ما الكلفة الحقيقية مقارنة بحجم التهويل؟']],
  ['التنسيق المفرط عبر المجالات','corpus',['هل هناك تزامن لافت بين الإعلام والعسكر والسياسة؟','هل يظهر المشهد بإخراج متقن أكثر من المعتاد؟','هل يعكس الواقع عادة هذا القدر من الانضباط؟','ما الدليل الذي يميز التنسيق عن الاستجابة لسبب مشترك؟','كيف يقارن ذلك بالتباين المعتاد في الأحداث؟']],
  ['رد الفعل المبالغ فيه','context',['هل جاء الرد سريعًا وبشكل تصعيدي غير متدرج؟','هل توجد تحركات لا تتناسب مع الحدث؟','هل يمثل الرد انحرافًا عن السلوك الطبيعي السابق؟','ما الذي يميز الرد الطبيعي عن الاستدراج المحتمل؟','هل توجد أدلة تربط الاستجابة بمحاولة خداع؟']],
  ['الإغلاق المعرفي','team',['هل حدث إجماع سريع داخل المؤسسة التحليلية؟','هل يتم رفض النقد أو الفرضيات البديلة؟','هل تم اختبار فرضية الخداع بشكل جدي؟','هل افترضنا أننا قد نكون مخدوعين؟','هل أُغلق النقاش قبل استكمال التحليل؟']]
];
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
  try { url = new URL(value); } catch { throw new Error('رابط مزود الذكاء الاصطناعي غير صالح.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('يجب أن يكون رابط المزود HTTPS ومن دون بيانات دخول داخله.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('عنوان مزود الذكاء الاصطناعي غير مسموح.');
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => isPrivateIp(record.address))) throw new Error('عنوان مزود الذكاء الاصطناعي غير مسموح.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function openAiText(raw) {
  if (typeof raw?.output_text === 'string') return raw.output_text;
  return (Array.isArray(raw?.output) ? raw.output : []).flatMap(item => Array.isArray(item?.content) ? item.content : [])
    .filter(item => item?.type === 'output_text' || typeof item?.text === 'string').map(item => item.text || '').join('');
}

function strictJsonSchema(value) {
  if (Array.isArray(value)) return value.map(strictJsonSchema);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strictJsonSchema(item)]));
  if (result.type === 'object') result.additionalProperties = false;
  return result;
}

function buildPrompt(caseFile, language, sources) {
  const sourceBlock = sources.map((s, i) => `\n--- SOURCE ${i + 1} ---\nID: ${s.id}\nTitle: ${s.title}\nPublisher: ${s.publisher || 'unknown'}\nAuthor: ${s.author || 'unknown'}\nDate: ${s.date || 'unknown'}\nShared origin: ${s.origin || 'not supplied'}\nURL: ${s.url || 'not supplied'}\nNotes: ${s.notes || 'none'}\nTEXT:\n${s.text}`).join('\n');
  const rubricBlock = RUBRIC.map((axis, i) => `\n${i + 1}. ${axis[0]} [scope=${axis[1]}]\n${axis[2].map((q, j) => `${i + 1}.${j + 1} ${q}`).join('\n')}`).join('\n');
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
10. Respect the scope label of every axis. corpus requires several independent items or a time series; context requires external baseline/context; team requires documented team-process evidence. If that scope is missing, use insufficient—not a speculative finding.
11. Do not infer intent, beneficiary, coordination, causation, or deception merely from timing, repetition, anonymity, coherence, or rhetoric. Identify the observable indicator separately from any hypothesis about intent.

For claims, use clear editorial verdicts such as supported, contradicted, partly supported, attributed only, or insufficient evidence, followed by a concrete reason. For scenarios, do not assign probabilities unless the evidence permits it; give support, counter-evidence, and a discriminating future trigger.

THE 45-QUESTION DIAGNOSTIC RUBRIC
${rubricBlock}

SUPPLIED SOURCES
${sourceBlock}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = cleanText(req.body?.apiKey || req.body?.geminiKey, 500);
  if (apiKey.length < 12) return res.status(401).json({ error: 'مفتاح مزود الذكاء الاصطناعي مفقود أو غير صالح.' });
  const provider = ['gemini', 'openai', 'custom'].includes(req.body?.provider) ? req.body.provider : 'gemini';
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

  const requestedModel = cleanText(req.body?.model, 160);
  if (requestedModel && !/^[a-zA-Z0-9._:/-]+$/.test(requestedModel)) return res.status(400).json({ error: 'معرّف النموذج غير صالح.' });
  const model = requestedModel || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-6.1-sol');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const prompt = buildPrompt(caseFile, cleanText(req.body.language, 80) || 'Arabic', sources);
    let endpoint, headers = { 'Content-Type': 'application/json' }, payload, providerLabel;
    if (provider === 'gemini') {
      if (!/^[a-zA-Z0-9._-]+$/.test(model)) return res.status(400).json({ error: 'معرّف نموذج Gemini غير صالح.' });
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.15, responseMimeType: 'application/json', responseSchema: schema } };
      providerLabel = 'Google Gemini';
    } else if (provider === 'openai') {
      endpoint = 'https://api.openai.com/v1/responses';
      headers.Authorization = `Bearer ${apiKey}`;
      payload = { model, input: prompt, text: { format: { type: 'json_schema', name: 'raqeeb_analysis', strict: true, schema: strictJsonSchema(schema) } } };
      providerLabel = 'OpenAI';
    } else {
      const base = await safeBaseUrl(cleanText(req.body?.baseUrl, 1000));
      endpoint = `${base}/chat/completions`;
      headers.Authorization = `Bearer ${apiKey}`;
      payload = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.15, response_format: { type: 'json_object' } };
      providerLabel = new URL(base).hostname;
    }
    const response = await fetch(endpoint, { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(payload) });
    const raw = await response.json();
    if (!response.ok) return res.status(502).json({ error: raw?.error?.message || `فشل الاتصال مع ${providerLabel}.` });
    const text = provider === 'gemini' ? (raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '') :
      provider === 'openai' ? openAiText(raw) : (raw?.choices?.[0]?.message?.content || '');
    let parsed;
    try { parsed = JSON.parse(text); } catch { return res.status(502).json({ error: `أعاد ${providerLabel} نتيجة غير قابلة للقراءة. أعد المحاولة أو اختر نموذجًا يدعم JSON.` }); }
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
        observation: cleanText(item.observation, 3000), alternative: cleanText(item.alternative, 2000), next_step: cleanText(item.next_step, 2000), author: providerLabel
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
      id: crypto.randomUUID(), created: new Date().toISOString(), mode: 'ai', provider: providerLabel, model, methodology: '0.2', language: cleanText(req.body.language, 80) || 'Arabic',
      summary: cleanText(parsed.summary, 8000), claims, scenarios, limitations: (Array.isArray(parsed.limitations) ? parsed.limitations : []).slice(0, 20).map(v => cleanText(v, 1500)),
      reviews, sources: caseFile.sources, changes: '', usage: { input_tokens: raw.usageMetadata?.promptTokenCount || raw.usage?.input_tokens || raw.usage?.prompt_tokens || null, output_tokens: raw.usageMetadata?.candidatesTokenCount || raw.usage?.output_tokens || raw.usage?.completion_tokens || null }
    });
  } catch (error) {
    return res.status(error.name === 'AbortError' || error.name === 'TimeoutError' ? 504 : 502).json({ error: error.name === 'AbortError' || error.name === 'TimeoutError' ? 'انتهت مهلة التحليل. قلّل حجم المصادر وحاول مجددًا.' : (error.message || 'تعذر الاتصال بمزود الذكاء الاصطناعي.') });
  } finally { clearTimeout(timer); }
};
