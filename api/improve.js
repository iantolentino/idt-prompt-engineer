import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 };
const GROQ_MODEL = 'llama3-8b-8192'; // Fast and capable model
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Optimized SYSTEM_PROMPT - condensed for fewer tokens while preserving effectiveness
const SYSTEM_PROMPT = `You are a senior engineer rewriting rough prompts into precise, execution-ready instructions for AI coding agents. Follow these rules:

1. Problem first: State current issue before fix, integrating stack/context into problem statement.
2. Numbered actions: Split requirements into distinct action steps; constraints attach to relevant step.
3. Exact verbs: Replace vague terms like "improve" with specific changes.
4. Explicit bounds: Add limits where open-ended; use [specify: x] for unknowns; never invent values.
5. Stack clarity: State language/framework/db if given; use [specify: stack] only if unknown.
6. Preserve existing: Keep behavior/data/naming unless told to change; add "do not modify" lines.
7. No invention: Never invent names (files, tables, etc.); use [specify: x] for unknowns.
8. DB safety: For schema/data changes, require rollback-safe approach; flag perf considerations.
9. Single approach: Propose one technical fix per problem; use [specify: approach] if ambiguous.
10. Unknown domain: If only general capability given (e.g., "search"), flag domain: [specify: where].
11. Confirmation: End with one-line verification statement.
12. Cut filler: Remove all words that don't affect agent action.

Output only the rewritten prompt.`;

// Grader prompt for evaluating improved prompts
const GRADER_SYSTEM_PROMPT = `You are an expert prompt engineer evaluating the quality of rewritten prompts. Score the given improved prompt on these criteria (0-10 each, then sum for 0-100):

1. Accuracy (0-10): Does it faithfully capture the user's intent without adding/removing meaning?
2. Hallucination (0-10): Does it avoid inventing specifics (names, tables, etc.) not in original?
3. On-topic (0-10): Does it stay focused on the requested task, not drifting?
4. Token Efficiency (0-10): Is it concise yet complete? Penalty for excessive length.
5. Clarity (0-10): Is it easy for an AI to understand? Clear structure, explicit actions.
6. Actionability (0-10): Does it provide clear, executable steps for a coding agent?
7. Rule Adherence (0-10): Does it follow the 12 rewrite rules (problem first, numbered steps, etc.)?

Provide scores as JSON: {"accuracy": X, "hallucination": Y, "on_topic": Z, "token_efficiency": A, "clarity": B, "actionability": C, "rule_adherence": D}. Then give brief feedback on lowest scoring areas.`;

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

// Helper function to estimate tokens (same as frontend)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).length * 1.3);
}

// Function to call Groq API
async function callGroq(messages) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: messages,
      temperature: 0.1,
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errorText}`);
  }

  return await response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing "prompt" in request body' });
  }

  // Check cache first
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
  const cacheKey = `improved:${promptHash}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const { improved, tokenUsage, grade } = JSON.parse(cached);
    // Update usage stats for cached hit (minimal cost)
    const usage = await getUsage();
    await recordUsage(usage.minuteKey, usage.dayKey, 1); // Just count the request
    const freshUsage = await getUsage();
    return res.status(200).json({ 
      improved, 
      tokenUsage, 
      usage: { minute: freshUsage.minute, day: freshUsage.day }, 
      limits: LIMITS,
      grade,
      cached: true
    });
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
    // Call Groq for prompt improvement
    const groqResponse = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]);

    const improved = groqResponse.choices?.[0]?.message?.content?.trim() || '(no response)';
    
    // Estimate token usage (Groq provides usage but we'll estimate for consistency)
    const tokenUsage = {
      prompt_tokens: estimateTokens(prompt),
      completion_tokens: estimateTokens(improved),
      total_tokens: estimateTokens(prompt) + estimateTokens(improved)
    };

    // Grade the improved prompt
    const gradeResponse = await callGroq([
      { role: 'system', content: GRADER_SYSTEM_PROMPT },
      { role: 'user', content: `Original prompt: ${prompt}\n\nImproved prompt:\n${improved}` }
    ]);

    const gradeText = gradeResponse.choices?.[0]?.message?.content?.trim() || '{}';
    
    // Parse grades from response
    let grades = {};
    let feedback = '';
    try {
      // Extract JSON from grade text
      const jsonMatch = gradeText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        grades = JSON.parse(jsonMatch);
        // Extract feedback (everything after the JSON)
        const jsonIndex = gradeText.indexOf(jsonMatch[0]);
        if (jsonIndex !== -1 && jsonIndex + jsonMatch[0].length < gradeText.length) {
          feedback = gradeText.substring(jsonIndex + jsonMatch[0].length).trim();
        }
      }
    } catch (e) {
      // If parsing fails, provide default grades
      grades = { 
        accuracy: 5, 
        hallucination: 5, 
        on_topic: 5, 
        token_efficiency: 5, 
        clarity: 5, 
        actionability: 5, 
        rule_adherence: 5 
      };
      feedback = 'Unable to parse grading response';
    }

    // Calculate total score
    const totalScore = Object.values(grades).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
    const grade = { scores: grades, total: totalScore, feedback };

    // Record usage
    const totalTokens = tokenUsage.total_tokens;
    await recordUsage(usage.minuteKey, usage.dayKey, totalTokens);
    const freshUsage = await getUsage();

    // Cache the result (TTL: 1 hour)
    await redis.setex(cacheKey, 3600, JSON.stringify({ improved, tokenUsage, grade }));

    return res.status(200).json({
      improved,
      tokenUsage,
      usage: { minute: freshUsage.minute, day: freshUsage.day },
      limits: LIMITS,
      grade
    });

  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}