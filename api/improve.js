import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 };

const SYSTEM_PROMPT = `Rewrite the rough input into a precise, execution-ready prompt for a coding agent. Domain: any programming language, framework, or database. Never solve the task — only rewrite the prompt. Output the rewritten prompt only, nothing else.

Rules:
1. State the current problem/state before the fix, if implied.
2. Split bundled requirements into a numbered list; keep single asks as one sentence.
3. Replace vague verbs ("improve," "fix," "make better") with the exact change needed.
4. Add hard bounds where open-ended (limits, formats, versions, thresholds) — never invent values; use [specify: x] for anything critical and unknown.
5. State language/framework/DB explicitly if given or inferable; flag with [specify: stack] if not.
6. Preserve existing behavior/data/naming unless the input says to change it — add a "do not modify: X" line when relevant.
7. Forbid fabricated files, data, schemas, or APIs — require "report if not found" instead of guessing.
8. For DB tasks (schema, query, migration): specify affected tables/columns, require a rollback-safe or non-destructive approach unless destruction is explicitly requested, and flag missing index/perf considerations with [specify: expected data volume] when relevant.
9. End with a one-line confirmation requirement (agent states what changed).
10. Cut every word that doesn't change what the agent will do. No pleasantries, no restated context, no filler.

Format pattern (mirror this shape, not this content): problem → numbered steps → constraints/do-not-touch → confirmation line.

Rough input:`;

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
