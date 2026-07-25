import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 };

const SYSTEM_PROMPT = `You are a prompt engineering assistant. Your only job is to take the rough
text I give you and rewrite it into a clearer, more effective prompt — you
never answer the question or perform the task itself, only improve the prompt.

When rewriting, follow these rules:

1. IDENTIFY INTENT FIRST — infer what the person is actually trying to
   accomplish, even if their wording is vague or messy.

2. STRUCTURE CLEARLY — use numbered steps or sections if the task has
   multiple parts. Keep single-purpose asks as clean, direct sentences
   (don't over-structure a simple request).

3. ADD CONCRETE CONSTRAINTS — if the original request could be interpreted
   too broadly (length, tone, format, scope), add specific bounds so the
   result is predictable.

4. PRESERVE USER INTENT — never add requirements, goals, or content the
   person didn't imply. Don't pad the prompt with unnecessary boilerplate.

5. BE TOKEN-EFFICIENT — the improved prompt should be as short as possible
   while losing zero clarity. Cut filler words and redundant phrasing.

6. FLAG AMBIGUITY — if something critical is missing (e.g. target audience,
   format, length) and can't be reasonably inferred, add one short bracketed
   note like [specify: target length] instead of guessing.

7. MULTI-PART TASKS MUST USE A NUMBERED LIST — if the rough input bundles two
   or more distinct actions/requirements (even run-on sentences joined by
   "and"), you MUST break them into a numbered list, one item per distinct
   requirement. Do not merge them back into a single sentence or paragraph.

Output ONLY the rewritten prompt. No preamble, no explanation, no markdown
headers around the whole output — just the improved prompt text itself,
ready to copy and paste.`;

async function getUsage() {
  const now = Date.now();
  const minuteKey = `usage:minute:${Math.floor(now / 60000)}`;
  const dayKey = `usage:day:${Math.floor(now / 86400000)}`;

  const [minReq, minTok, dayReq, dayTok] = await Promise.all([
    redis.get(`${minuteKey}:req`) || 0,
    redis.get(`${minuteKey}:tok`) || 0,
    redis.get(`${dayKey}:req`) || 0,
    redis.get(`${dayKey}:tok`) || 0,
  ]);

  return {
    minuteKey, dayKey,
    minute: { requests: minReq || 0, tokens: minTok || 0 },
    day: { requests: dayReq || 0, tokens: dayTok || 0 }
  };
}

async function recordUsage(minuteKey, dayKey, tokens) {
  await Promise.all([
    redis.incrby(`${minuteKey}:req`, 1),
    redis.incrby(`${minuteKey}:tok`, tokens),
    redis.expire(`${minuteKey}:req`, 120),
    redis.expire(`${minuteKey}:tok`, 120),
    redis.incrby(`${dayKey}:req`, 1),
    redis.incrby(`${dayKey}:tok`, tokens),
    redis.expire(`${dayKey}:req`, 172800),
    redis.expire(`${dayKey}:tok`, 172800),
  ]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing "prompt" in request body' });
  }

  const usage = await getUsage();
  if (usage.minute.requests >= LIMITS.reqPerMin) {
    return res.status(429).json({ error: 'Hit the per-minute request limit (30/min). Wait ~60s and try again.', usage });
  }
  if (usage.minute.tokens >= LIMITS.tokPerMin) {
    return res.status(429).json({ error: 'Hit the per-minute token limit (12,000/min). Wait ~60s and try again.', usage });
  }
  if (usage.day.requests >= LIMITS.reqPerDay) {
    return res.status(429).json({ error: 'Hit the daily request limit (1,000/day). Try again tomorrow.', usage });
  }
  if (usage.day.tokens >= LIMITS.tokPerDay) {
    return res.status(429).json({ error: 'Hit the daily token limit (100,000/day). Try again tomorrow.', usage });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return res.status(groqRes.status).json({ error: `Groq API error: ${errText}` });
    }

    const data = await groqRes.json();
    const improved = data.choices?.[0]?.message?.content?.trim() || '(no response)';
    const tokenUsage = data.usage || {};
    const totalTokens = (tokenUsage.prompt_tokens || 0) + (tokenUsage.completion_tokens || 0);

    await recordUsage(usage.minuteKey, usage.dayKey, totalTokens);
    const freshUsage = await getUsage();

    return res.status(200).json({
      improved,
      tokenUsage,
      usage: { minute: freshUsage.minute, day: freshUsage.day },
      limits: LIMITS
    });

  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}
