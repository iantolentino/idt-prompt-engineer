````javascript
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = Redis.fromEnv();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b';

// Rate limits.
// These limit API usage, NOT the length of the user's prompt or Groq's output.
const LIMITS = {
  reqPerMin: 30,
  reqPerDay: 1000,
  tokPerMin: 12000,
  tokPerDay: 100000
};

const SYSTEM_PROMPT = `
You are an expert prompt engineer and senior software/AI engineering mentor.

Your task is to transform the user's raw prompt into a significantly better prompt that another AI can execute accurately.

The goal is genuine prompt improvement, not simple paraphrasing.

CORE RULES:

1. Preserve the user's original intent.
   Do not remove requirements, goals, constraints, preferences, or important context.

2. Improve clarity.
   Turn vague instructions into clear, actionable instructions whenever possible.

3. Do not invent information.
   Do not silently add technologies, frameworks, programming languages, databases, APIs, cloud providers, features, architecture decisions, business requirements, or other details that the user did not provide.

4. Handle missing information explicitly.
   When an important detail is unknown and the AI needs it, use:
   [specify: what is needed]
   instead of making up an answer.

5. Preserve explicit technology choices.
   If the user specifies a language, framework, database, platform, API, hosting provider, or tool, keep it unless the user explicitly asks for alternatives.

6. Do not unnecessarily constrain the user.
   Do not add arbitrary limits, deadlines, technologies, architectures, or implementation choices.

7. Make instructions actionable.
   The improved prompt should make it clear what the AI needs to do and what the expected result should contain.

8. Use appropriate structure.
   Organize complex prompts into sections such as:
   Goal
   Context
   Requirements
   Constraints
   Expected Output
   Implementation Steps
   Acceptance Criteria
   Learning Objectives
   only when those sections genuinely improve the prompt.

9. For software-development requests:
   Make requirements, existing systems, technical constraints, expected behavior, testing, security, deployment, and deliverables clear when relevant.
   Do not invent a technology stack if one was not provided.

10. For learning-oriented requests:
    Preserve the user's desire to learn.
    If appropriate, instruct the AI to explain important decisions, concepts, trade-offs, and implementation steps rather than simply producing code.

11. For AI-related requests:
    Make the desired AI behavior, inputs, outputs, constraints, failure handling, and evaluation requirements clear when relevant.

12. For database or production-related requests:
    Preserve safety requirements.
    Avoid instructions that could cause destructive changes without confirmation.

13. Prefer one coherent approach.
    Do not unnecessarily provide multiple competing implementations unless the user asks for alternatives.

14. Remove filler.
    Eliminate repetition, unnecessary introductions, marketing language, and vague motivational language.

15. Do not make the prompt artificially short.
    Keep all useful information.
    Use as much text as necessary to make the prompt complete and executable.

OUTPUT RULES:

- Return ONLY the improved prompt.
- Do not explain what you changed.
- Do not add commentary before or after the improved prompt.
- Do not wrap the result in Markdown code fences.
- Do not use asterisks for bold, emphasis, or decorative formatting.
- Avoid unnecessary Markdown formatting.
- Numbered lists are allowed when they improve clarity.
- Headings are allowed when they improve organization.
- Do not impose an arbitrary word or character limit.
- Do not truncate useful requirements.
- Do not add information that was not supported by the user's request.
- The final result should be a prompt that another AI can directly use.
`;

function hashPrompt(prompt) {
  return crypto
    .createHash('sha256')
    .update(prompt)
    .digest('hex');
}

function estimateTokens(text) {
  if (!text) return 0;

  // Fallback approximation when the API does not return token usage.
  return Math.ceil(text.length / 4);
}

async function getUsage(ip) {
  const minuteKey = `usage:min:${ip}`;
  const dayKey = `usage:day:${ip}`;
  const tokenMinuteKey = `usage:tok:min:${ip}`;
  const tokenDayKey = `usage:tok:day:${ip}`;

  const [reqMin, reqDay, tokMin, tokDay] = await Promise.all([
    redis.get(minuteKey),
    redis.get(dayKey),
    redis.get(tokenMinuteKey),
    redis.get(tokenDayKey)
  ]);

  return {
    reqMin: Number(reqMin || 0),
    reqDay: Number(reqDay || 0),
    tokMin: Number(tokMin || 0),
    tokDay: Number(tokDay || 0)
  };
}

async function recordUsage(ip, tokens) {
  const minuteKey = `usage:min:${ip}`;
  const dayKey = `usage:day:${ip}`;
  const tokenMinuteKey = `usage:tok:min:${ip}`;
  const tokenDayKey = `usage:tok:day:${ip}`;

  await Promise.all([
    redis.incr(minuteKey),
    redis.incr(dayKey),
    redis.incrby(tokenMinuteKey, tokens),
    redis.incrby(tokenDayKey, tokens)
  ]);

  await Promise.all([
    redis.expire(minuteKey, 60),
    redis.expire(dayKey, 86400),
    redis.expire(tokenMinuteKey, 60),
    redis.expire(tokenDayKey, 86400)
  ]);
}

async function callGroq(messages) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.2,

      // This is an output allowance, not a character/word limit.
      // The model can return much less when less output is required.
      max_completion_tokens: 8000
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Groq API request failed with status ${response.status}`;

    throw new Error(message);
  }

  const choice = data?.choices?.[0];

  if (!choice) {
    throw new Error('Groq returned no completion.');
  }

  return {
    content: choice.message?.content?.trim() || '',
    usage: data.usage || {}
  };
}

function cleanImprovedPrompt(text) {
  if (!text) return '';

  let cleaned = text.trim();

  // Remove accidental Markdown code fences.
  cleaned = cleaned.replace(/^```(?:text|markdown)?\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  // Remove common model introductions.
  cleaned = cleaned.replace(
    /^(here(?:'s| is) (?:the )?(?:improved|optimized|refined) prompt:)\s*/i,
    ''
  );

  return cleaned.trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: 'GROQ_API_KEY is not configured.'
      });
    }

    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      'unknown';

    const originalPrompt =
      typeof req.body?.prompt === 'string'
        ? req.body.prompt.trim()
        : '';

    if (!originalPrompt) {
      return res.status(400).json({
        error: 'Prompt is required.'
      });
    }

    /*
     * Check API usage limits.
     *
     * These limits do not restrict the user's prompt length
     * or the length of the improved prompt.
     */
    const usage = await getUsage(ip);

    if (usage.reqMin >= LIMITS.reqPerMin) {
      return res.status(429).json({
        error: 'Too many requests. Please try again in a minute.'
      });
    }

    if (usage.reqDay >= LIMITS.reqPerDay) {
      return res.status(429).json({
        error: 'Daily request limit reached.'
      });
    }

    if (usage.tokMin >= LIMITS.tokPerMin) {
      return res.status(429).json({
        error: 'Minute token limit reached. Please try again shortly.'
      });
    }

    if (usage.tokDay >= LIMITS.tokPerDay) {
      return res.status(429).json({
        error: 'Daily token limit reached.'
      });
    }

    /*
     * Cache based on the original prompt.
     */
    const promptHash = hashPrompt(originalPrompt);
    const cacheKey = `improve:${promptHash}`;

    /*
     * Upstash Redis automatically serializes/deserializes
     * JSON-compatible values.
     *
     * New cache entries are therefore returned as objects.
     *
     * The string compatibility block supports old cache entries
     * that may have been stored before the previous fix.
     */
    const cached = await redis.get(cacheKey);

    if (cached) {
      let cacheData = cached;

      if (typeof cacheData === 'string') {
        try {
          cacheData = JSON.parse(cacheData);
        } catch {
          cacheData = null;
        }
      }

      if (
        cacheData &&
        typeof cacheData === 'object' &&
        typeof cacheData.improved === 'string'
      ) {
        const cachedTokens =
          Number(cacheData.tokenUsage?.totalTokens) || 1;

        await recordUsage(ip, cachedTokens);

        return res.status(200).json({
          improved: cacheData.improved,
          tokenUsage: cacheData.tokenUsage || {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: cachedTokens
          },
          cached: true
        });
      }
    }

    /*
     * ONE Groq request.
     *
     * There is intentionally NO grading request.
     * The application only improves the user's prompt.
     */
    const result = await callGroq([
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: originalPrompt
      }
    ]);

    const improved = cleanImprovedPrompt(result.content);

    if (!improved) {
      throw new Error('Groq returned an empty improved prompt.');
    }

    /*
     * Use actual Groq token usage when available.
     * Fall back to estimation if usage is unavailable.
     */
    const promptTokens =
      Number(result.usage?.prompt_tokens) ||
      estimateTokens(originalPrompt);

    const completionTokens =
      Number(result.usage?.completion_tokens) ||
      estimateTokens(improved);

    const totalTokens =
      Number(result.usage?.total_tokens) ||
      promptTokens + completionTokens;

    const tokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens
    };

    /*
     * Record this request's actual usage.
     */
    await recordUsage(ip, totalTokens);

    /*
     * Cache only the improved result and token usage.
     *
     * No grade is stored because this API no longer grades prompts.
     */
    const cacheData = {
      improved,
      tokenUsage
    };

    /*
     * Upstash Redis handles serialization automatically.
     */
    await redis.setex(cacheKey, 3600, cacheData);

    return res.status(200).json({
      improved,
      tokenUsage,
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

