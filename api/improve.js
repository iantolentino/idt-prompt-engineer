import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

const LIMITS = {
  reqPerMin: 30,
  reqPerDay: 1000,
  tokPerMin: 12000,
  tokPerDay: 100000
};

// Groq model
const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Optimized system prompt
const SYSTEM_PROMPT = `You are a senior engineer rewriting rough prompts into precise, execution-ready instructions for AI coding agents. Follow these rules:

1. Problem first: State current issue before fix, integrating stack/context into problem statement.
2. Numbered actions: Split requirements into distinct action steps; constraints attach to relevant step.
3. Exact verbs: Replace vague terms like "improve" with specific changes.
4. Explicit bounds: Add limits where open-ended; use [specify: x] for unknowns; never invent values.
5. Stack clarity: State language/framework/db if given; use [specify: stack] only if unknown.
6. Preserve existing: Keep behavior/data/naming unless told to change; add "do not modify" lines.
7. No invention: Never invent names (files, tables, etc.); use [specify: x] for unknowns.
8. DB safety: For schema/data changes, require rollback-safe approach; flag performance considerations.
9. Single approach: Propose one technical fix per problem; use [specify: approach] if ambiguous.
10. Unknown domain: If only general capability is given (e.g., "search"), flag domain: [specify: where].
11. Confirmation: End with one-line verification statement.
12. Cut filler: Remove all words that don't affect agent action.

Output only the rewritten prompt.`;

// Grader prompt
const GRADER_SYSTEM_PROMPT = `You are an expert prompt engineer evaluating the quality of a rewritten prompt.

Evaluate the improved prompt against the original prompt.

Score each criterion from 0-10:

1. Accuracy: Does it faithfully capture the user's intent without adding or removing meaning?
2. Hallucination: Does it avoid inventing specifics not present in the original?
3. On-topic: Does it stay focused on the requested task?
4. Token Efficiency: Is it concise while remaining complete?
5. Clarity: Is the prompt easy for an AI to understand?
6. Actionability: Does it provide clear, executable instructions?
7. Rule Adherence: Does it follow the 12 rewriting rules?

Return ONLY valid JSON in exactly this format:

{
  "accuracy": 0,
  "hallucination": 0,
  "on_topic": 0,
  "token_efficiency": 0,
  "clarity": 0,
  "actionability": 0,
  "rule_adherence": 0,
  "feedback": "Brief feedback explaining the most important weaknesses."
}

All scores must be numbers from 0 to 10.`;

// Get usage
async function getUsage() {
  const now = Date.now();

  const minuteKey = `usage:minute:${Math.floor(now / 60000)}`;
  const dayKey = `usage:day:${Math.floor(now / 86400000)}`;

  const [
    minReq,
    minTok,
    dayReq,
    dayTok
  ] = await Promise.all([
    redis.get(`${minuteKey}:req`),
    redis.get(`${minuteKey}:tok`),
    redis.get(`${dayKey}:req`),
    redis.get(`${dayKey}:tok`)
  ]);

  return {
    minuteKey,
    dayKey,
    minute: {
      requests: Number(minReq) || 0,
      tokens: Number(minTok) || 0
    },
    day: {
      requests: Number(dayReq) || 0,
      tokens: Number(dayTok) || 0
    }
  };
}

// Record usage
async function recordUsage(minuteKey, dayKey, tokens) {
  await Promise.all([
    redis.incrby(`${minuteKey}:req`, 1),
    redis.incrby(`${minuteKey}:tok`, tokens),
    redis.expire(`${minuteKey}:req`, 120),
    redis.expire(`${minuteKey}:tok`, 120),

    redis.incrby(`${dayKey}:req`, 1),
    redis.incrby(`${dayKey}:tok`, tokens),
    redis.expire(`${dayKey}:req`, 172800),
    redis.expire(`${dayKey}:tok`, 172800)
  ]);
}

// Estimate tokens
function estimateTokens(text) {
  if (!text) return 0;

  return Math.ceil(
    text.trim().split(/\s+/).length * 1.3
  );
}

// Call Groq API
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
      messages,
      temperature: 0.1,
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Groq API error: ${response.status} ${errorText}`
    );
  }

  return await response.json();
}

// Safely extract JSON from grader response
function parseGraderResponse(text) {
  const defaultScores = {
    accuracy: 5,
    hallucination: 5,
    on_topic: 5,
    token_efficiency: 5,
    clarity: 5,
    actionability: 5,
    rule_adherence: 5
  };

  if (!text || typeof text !== 'string') {
    return {
      scores: defaultScores,
      feedback: 'Unable to parse grading response.'
    };
  }

  try {
    // Remove markdown code fences if the model adds them
    const cleaned = text
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    // Find the first JSON object
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      return {
        scores: defaultScores,
        feedback: 'Unable to parse grading response.'
      };
    }

    const jsonText = cleaned.substring(start, end + 1);
    const parsed = JSON.parse(jsonText);

    const scores = {
      accuracy: clampScore(parsed.accuracy),
      hallucination: clampScore(parsed.hallucination),
      on_topic: clampScore(parsed.on_topic),
      token_efficiency: clampScore(parsed.token_efficiency),
      clarity: clampScore(parsed.clarity),
      actionability: clampScore(parsed.actionability),
      rule_adherence: clampScore(parsed.rule_adherence)
    };

    const feedback =
      typeof parsed.feedback === 'string'
        ? parsed.feedback.trim()
        : 'No feedback provided.';

    return {
      scores,
      feedback
    };

  } catch (error) {
    console.error('Grader JSON parse error:', error);

    return {
      scores: defaultScores,
      feedback: 'Unable to parse grading response.'
    };
  }
}

// Keep individual score between 0 and 10
function clampScore(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 5;
  }

  return Math.min(10, Math.max(0, number));
}

// Calculate normalized 0-100 score
function calculateTotalScore(scores) {
  const values = [
    scores.accuracy,
    scores.hallucination,
    scores.on_topic,
    scores.token_efficiency,
    scores.clarity,
    scores.actionability,
    scores.rule_adherence
  ];

  const rawScore = values.reduce(
    (sum, value) => sum + value,
    0
  );

  // 7 criteria × 10 = 70 maximum.
  // Normalize to 100.
  return Math.round((rawScore / 70) * 100);
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Use POST'
    });
  }

  try {
    const { prompt } = req.body || {};

    // Validate prompt
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'Missing "prompt" in request body'
      });
    }

    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      return res.status(400).json({
        error: 'Prompt cannot be empty'
      });
    }

    // Check cache
    const promptHash = crypto
      .createHash('sha256')
      .update(trimmedPrompt)
      .digest('hex');

    const cacheKey = `improved:${promptHash}`;

    const cached = await redis.get(cacheKey);

    /*
     * IMPORTANT:
     * @upstash/redis automatically deserializes JSON values.
     *
     * Therefore cached is already an object.
     * DO NOT use JSON.parse(cached).
     */
    if (cached && typeof cached === 'object') {
      const {
        improved,
        tokenUsage,
        grade
      } = cached;

      // Count cached request
      const usage = await getUsage();

      await recordUsage(
        usage.minuteKey,
        usage.dayKey,
        1
      );

      const freshUsage = await getUsage();

      return res.status(200).json({
        improved,
        tokenUsage,
        usage: {
          minute: freshUsage.minute,
          day: freshUsage.day
        },
        limits: LIMITS,
        grade,
        cached: true
      });
    }

    // Check rate limits
    const usage = await getUsage();

    if (usage.minute.requests >= LIMITS.reqPerMin) {
      return res.status(429).json({
        error: 'Hit the per-minute request limit (30/min). Wait ~60s and try again.',
        usage
      });
    }

    if (usage.minute.tokens >= LIMITS.tokPerMin) {
      return res.status(429).json({
        error: 'Hit the per-minute token limit (12,000/min). Wait ~60s and try again.',
        usage
      });
    }

    if (usage.day.requests >= LIMITS.reqPerDay) {
      return res.status(429).json({
        error: 'Hit the daily request limit (1,000/day). Try again tomorrow.',
        usage
      });
    }

    if (usage.day.tokens >= LIMITS.tokPerDay) {
      return res.status(429).json({
        error: 'Hit the daily token limit (100,000/day). Try again tomorrow.',
        usage
      });
    }

    // ==========================================
    // 1. IMPROVE PROMPT
    // ==========================================

    const groqResponse = await callGroq([
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: trimmedPrompt
      }
    ]);

    const improved =
      groqResponse.choices?.[0]?.message?.content?.trim() ||
      '(no response)';

    // Estimate improvement token usage
    const promptTokens = estimateTokens(trimmedPrompt);
    const completionTokens = estimateTokens(improved);

    const tokenUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };

    // ==========================================
    // 2. GRADE IMPROVED PROMPT
    // ==========================================

    const gradeResponse = await callGroq([
      {
        role: 'system',
        content: GRADER_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content:
          `Original prompt:\n${trimmedPrompt}\n\n` +
          `Improved prompt:\n${improved}`
      }
    ]);

    const gradeText =
      gradeResponse.choices?.[0]?.message?.content?.trim() ||
      '';

    const parsedGrade = parseGraderResponse(gradeText);

    const totalScore = calculateTotalScore(
      parsedGrade.scores
    );

    const grade = {
      scores: parsedGrade.scores,
      total: totalScore,
      feedback: parsedGrade.feedback
    };

    // ==========================================
    // 3. RECORD USAGE
    // ==========================================

    /*
     * Include both improvement and grading calls.
     * The previous version only estimated the improvement call.
     */
    const gradePromptTokens = estimateTokens(
      trimmedPrompt + improved
    );

    const gradeCompletionTokens = estimateTokens(
      gradeText
    );

    const totalTokens =
      tokenUsage.total_tokens +
      gradePromptTokens +
      gradeCompletionTokens;

    await recordUsage(
      usage.minuteKey,
      usage.dayKey,
      totalTokens
    );

    const freshUsage = await getUsage();

    // ==========================================
    // 4. CACHE RESULT
    // ==========================================

    const cacheData = {
      improved,
      tokenUsage,
      grade
    };

    /*
     * Redis accepts objects directly.
     * It will serialize them automatically.
     */
    await redis.setex(
      cacheKey,
      3600,
      cacheData
    );

    // ==========================================
    // 5. RESPONSE
    // ==========================================

    return res.status(200).json({
      improved,
      tokenUsage,
      usage: {
        minute: freshUsage.minute,
        day: freshUsage.day
      },
      limits: LIMITS,
      grade,
      cached: false
    });

  } catch (err) {
    console.error('Prompt improvement error:', err);

    return res.status(500).json({
      error: `Server error: ${
        err instanceof Error
          ? err.message
          : String(err)
      }`
    });
  }
}
