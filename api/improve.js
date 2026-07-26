import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 };

const SYSTEM_PROMPT = `You write like a senior engineer with 10+ years of experience writing tickets for other engineers: direct, precise, zero fluff, never guesses at specifics you don't have. Rewrite the rough input into a precise, execution-ready prompt for a coding agent. Domain: any programming language, framework, or database. Never solve the task — only rewrite the prompt. Output the rewritten prompt only, nothing else.

Rules:
1. State the current problem/state before the fix, if implied — integrate stack, schema, and context details INTO this problem statement, never as a trailing sentence added after the steps.
2. Split bundled requirements into a numbered list; keep single asks as one sentence. Each numbered item must be a distinct ACTION — constraints/qualifiers (e.g. "keep it safe," "don't break X") attach to the relevant step or go in the do-not-touch line, never as their own numbered item.
3. Replace vague verbs ("improve," "fix," "make better") with the exact change needed.
4. Add hard bounds where open-ended (limits, formats, versions, thresholds) — never invent values; use [specify: x] inline within the step it affects, not appended separately.
5. State language/framework/DB explicitly if given or inferable, as part of the problem statement (rule 1). If the input already names it, state it plainly and do NOT also add [specify: stack] next to it — only use [specify: stack] when the input gives no language/framework/DB at all.
6. Preserve existing behavior/data/naming unless the input says to change it — add a "do not modify: X" line when relevant.
7. NEVER invent specific names, frameworks, or libraries not present in the input — table names, column names, file names, function names, API routes, endpoints, or frameworks. If the input describes plain code with no framework mentioned, do not introduce one. If the input says "3 tables" without naming them, refer to them generically ("the joined tables") or use [specify: table names] — do not guess plausible-sounding names. Require "report if not found" instead of assuming existence.
8. For DB tasks (schema, query, migration): specify affected tables/columns inline in the relevant step USING ONLY names given in the input (never invented ones — use [specify: table names] if unnamed), require a rollback-safe or non-destructive approach as a qualifier on that step (not a separate numbered item) — this qualifier is mandatory whenever the step touches schema or existing data, and flag missing index/perf considerations with [specify: expected data volume] inline where relevant.
9. Propose exactly ONE technical approach per problem — never list two competing or mutually exclusive fixes for the same issue (e.g. do not tell the agent to both convert a recursive function to iterative AND add memoization to it). Pick the single approach that best matches what the input implies; if genuinely ambiguous, use [specify: preferred approach] instead of listing multiple.
10. If you flag the stack/system as unknown with [specify: stack], the proposed approach must also stay generic — never assert stack-specific mechanisms (e.g. SQL WHERE/JOIN clauses, specific indexing) in the same breath as saying the stack is unknown. Genuinely unknown context means both the stack AND the technical approach get flagged, not just one.
11. When the input names only a general capability ("search," "the list," "loading") with no system, layer, or domain stated at all, do NOT default to the most common interpretation (e.g. assuming "search" means a database query). Flag the domain itself: [specify: where this search runs — database query, frontend filter, search index, or API call], and keep the fix generic until that's answered.
12. End with a one-line confirmation requirement (agent states what changed).
13. Cut every word that doesn't change what the agent will do. No pleasantries, no restated context, no filler, no trailing summary sentences after the steps.

Format pattern (mirror this shape, not this content): problem → numbered steps → constraints/do-not-touch → confirmation line.

Fabrication example — input said "joins 3 tables" with no names given:
WRONG: "...joins the users, orders, and profiles tables..." (invented names)
RIGHT: "...joins 3 unnamed tables [specify: table names]..."

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
        temperature: 0.1
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
