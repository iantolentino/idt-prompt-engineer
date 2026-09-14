const { Redis } = require('@upstash/redis'); const crypto = require('crypto'); const redis = Redis.fromEnv(); const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'; const GROQ_MODEL = 'openai/gpt-oss-20b'; // Application rate limits. // These are usage-protection limits, not limits on the length of an individual prompt. const LIMITS = { reqPerMin: 30, reqPerDay: 1000, tokPerMin: 12000, tokPerDay: 100000 }; const SYSTEM_PROMPT = ` You are an expert prompt engineer and senior software/AI engineering mentor. Your job is to transform the user's raw prompt into a significantly better prompt that another AI can execute accurately. IMPORTANT: - Preserve the user's actual intent. - Improve the prompt; do not merely rephrase it. - Do not invent technologies, requirements, features, architecture, APIs, databases, services, or implementation details that the user did not request. - When an important technical decision is unknown, explicitly mark it as [specify: X] instead of guessing. - You may add useful constraints when they directly improve correctness, safety, or execution. - Do not remove important requirements just to make the prompt shorter. - Do not add unnecessary complexity. - Make the resulting prompt actionable and unambiguous. - If the user is asking for software development, clearly separate the goal, requirements, constraints, expected behavior, and deliverables where useful. - Preserve existing technology choices when the user explicitly provided them. - If no technology stack was specified, do not silently choose one. - If the user wants to learn, make the AI act as both an expert implementer and a technical mentor. - The improved prompt should tell the AI what to build/do, what decisions need to be explained, and what should be delivered. - For security-sensitive or destructive operations, require confirmation before irreversible actions. - Do not claim that something exists, has been tested, deployed, or verified unless the user explicitly said so. - Avoid filler, repetition, marketing language, and unnecessary explanations. OUTPUT FORMAT: - Return ONLY the improved prompt. - Do not explain what you changed. - Do not wrap the prompt in Markdown code fences. - Do not use asterisks for bold or emphasis. - Do not use decorative Markdown. - Do not add a "Here's your improved prompt" introduction. - Numbered lists are allowed when they make instructions clearer. - Use headings only when they genuinely improve organization. - Do not impose an arbitrary word, character, or sentence limit. - Use as much text as necessary to fully specify the user's request. - At the same time, remove unnecessary verbosity and repetition. - The final prompt should be complete rather than artificially short. `; const GRADER_SYSTEM_PROMPT = ` You are a strict prompt-quality evaluator. Evaluate the improved prompt against the original prompt. Score each criterion from 0 to 10: 1. Accuracy Does the improved prompt correctly represent the user's request? 2. Hallucination Does it avoid inventing unsupported technologies, requirements, facts, or assumptions? 10 = no problematic invention. 3. On-topic Does it remain focused on the user's actual goal? 4. Token Efficiency Does it remove unnecessary repetition and filler while retaining useful detail? A longer prompt is NOT automatically inefficient if the extra detail is useful. 5. Clarity Are the instructions unambiguous and easy for another AI to follow? 6. Actionability Can another AI actually execute the request from the improved prompt? 7. Rule Adherence Does the prompt follow the prompt-engineering rules, including preserving intent, avoiding unsupported assumptions, and handling unknowns appropriately? Return ONLY valid JSON in this exact structure: { "scores": { "accuracy": 0, "hallucination": 0, "onTopic": 0, "tokenEfficiency": 0, "clarity": 0, "actionability": 0, "ruleAdherence": 0 }, "feedback": "Brief explanation of the main strengths and weaknesses." } Do not return Markdown. Do not wrap the JSON in code fences. `; function hashPrompt(prompt) { return crypto .createHash('sha256') .update(prompt) .digest('hex'); } function estimateTokens(text) { if (!text) return 0; // Approximate token count. // Actual token usage is taken from the Groq API when available. return Math.ceil(text.length / 4); } async function getUsage(ip) { const minuteKey = `usage:min:${ip}`; const dayKey = `usage:day:${ip}`; const tokenMinuteKey = `usage:tok:min:${ip}`; const tokenDayKey = `usage:tok:day:${ip}`; const [reqMin, reqDay, tokMin, tokDay] = await Promise.all([ redis.get(minuteKey), redis.get(dayKey), redis.get(tokenMinuteKey), redis.get(tokenDayKey) ]); return { reqMin: Number(reqMin || 0), reqDay: Number(reqDay || 0), tokMin: Number(tokMin || 0), tokDay: Number(tokDay || 0) }; } async function recordUsage(ip, tokens) { const minuteKey = `usage:min:${ip}`; const dayKey = `usage:day:${ip}`; const tokenMinuteKey = `usage:tok:min:${ip}`; const tokenDayKey = `usage:tok:day:${ip}`; await Promise.all([ redis.incr(minuteKey), redis.incr(dayKey), redis.incrby(tokenMinuteKey, tokens), redis.incrby(tokenDayKey, tokens) ]); await Promise.all([ redis.expire(minuteKey, 60), redis.expire(dayKey, 86400), redis.expire(tokenMinuteKey, 60), redis.expire(tokenDayKey, 86400) ]); } async function callGroq(messages) { const response = await fetch(GROQ_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.2, // This is the model output allowance. // There is no application-level character/word limit. max_completion_tokens: 8000 }) }); const data = await response.json(); if (!response.ok) { const message = data?.error?.message || `Groq API request failed with status ${response.status}`; throw new Error(message); } const choice = data?.choices?.[0]; if (!choice) { throw new Error('Groq returned no completion.'); } return { content: choice.message?.content?.trim() || '', usage: data.usage || {} }; } function cleanImprovedPrompt(text) { if (!text) return ''; let cleaned = text.trim(); // Remove accidental surrounding Markdown code fences. cleaned = cleaned.replace(/^```(?:text|markdown)?\s*/i, ''); cleaned = cleaned.replace(/\s*```$/i, ''); // Remove a common introductory phrase if the model ignores the // "return only the prompt" instruction. cleaned = cleaned.replace( /^(here(?:'s| is) (?:the )?(?:improved|optimized|refined) prompt:)\s*/i, '' ); return cleaned.trim(); } function clampScore(value) { const number = Number(value); if (!Number.isFinite(number)) { return 0; } return Math.max(0, Math.min(10, number)); } function calculateTotalScore(scores) { const values = [ scores.accuracy, scores.hallucination, scores.onTopic, scores.tokenEfficiency, scores.clarity, scores.actionability, scores.ruleAdherence ].map(clampScore); const rawScore = values.reduce((sum, value) => sum + value, 0); // 7 criteria × 10 = 70 maximum. // Normalize to a 0–100 grade. return Math.round((rawScore / 70) * 100); } function parseGraderResponse(content) { if (!content) { throw new Error('Grader returned an empty response.'); } let cleaned = content.trim(); // Remove Markdown code fences if the grader accidentally adds them. cleaned = cleaned.replace(/^```json\s*/i, ''); cleaned = cleaned.replace(/^```\s*/i, ''); cleaned = cleaned.replace(/\s*```$/i, ''); let parsed; try { parsed = JSON.parse(cleaned); } catch (error) { // Try to extract the first JSON object. const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}'); if (start === -1 || end === -1 || end <= start) { throw new Error('Unable to parse grader JSON.'); } parsed = JSON.parse(cleaned.slice(start, end + 1)); } const rawScores = parsed.scores || {}; const scores = { accuracy: clampScore(rawScores.accuracy), hallucination: clampScore(rawScores.hallucination), onTopic: clampScore(rawScores.onTopic), tokenEfficiency: clampScore(rawScores.tokenEfficiency), clarity: clampScore(rawScores.clarity), actionability: clampScore(rawScores.actionability), ruleAdherence: clampScore(rawScores.ruleAdherence) }; return { scores, totalScore: calculateTotalScore(scores), feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '' }; } export default async function handler(req, res) { if (req.method !== 'POST') { return res.status(405).json({ error: 'Method not allowed.' }); } try { if (!process.env.GROQ_API_KEY) { return res.status(500).json({ error: 'GROQ_API_KEY is not configured.' }); } const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown'; const originalPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''; if (!originalPrompt) { return res.status(400).json({ error: 'Prompt is required.' }); } const usage = await getUsage(ip); if (usage.reqMin >= LIMITS.reqPerMin) { return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' }); } if (usage.reqDay >= LIMITS.reqPerDay) { return res.status(429).json({ error: 'Daily request limit reached.' }); } if (usage.tokMin >= LIMITS.tokPerMin) { return res.status(429).json({ error: 'Minute token limit reached. Please try again shortly.' }); } if (usage.tokDay >= LIMITS.tokPerDay) { return res.status(429).json({ error: 'Daily token limit reached.' }); } const promptHash = hashPrompt(originalPrompt); const cacheKey = `improve:${promptHash}`; /* * Upstash Redis automatically serializes/deserializes JSON-compatible * values. Therefore redis.get() may return an object directly. */ const cached = await redis.get(cacheKey); if (cached) { let cacheData = cached; // Compatibility with any older cache entries that were stored // as JSON strings. if (typeof cacheData === 'string') { try { cacheData = JSON.parse(cacheData); } catch { cacheData = null; } } if ( cacheData && typeof cacheData === 'object' && typeof cacheData.improved === 'string' ) { await recordUsage( ip, Number(cacheData.tokenUsage?.totalTokens || 1) ); return res.status(200).json({ improved: cacheData.improved, tokenUsage: cacheData.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, grade: cacheData.grade || null, cached: true }); } } /* * STEP 1: * Improve the user's prompt. */ const improvementResult = await callGroq([ { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: originalPrompt } ]); const improved = cleanImprovedPrompt(improvementResult.content); if (!improved) { throw new Error('Groq returned an empty improved prompt.'); } /* * STEP 2: * Grade the improved prompt against the original. */ const graderResult = await callGroq([ { role: 'system', content: GRADER_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ originalPrompt, improvedPrompt: improved }) } ]); const grade = parseGraderResponse(graderResult.content); /* * Prefer actual Groq token usage. * Fall back to estimation if the API does not provide usage. */ const improvementPromptTokens = Number(improvementResult.usage?.prompt_tokens) || estimateTokens(originalPrompt); const improvementCompletionTokens = Number(improvementResult.usage?.completion_tokens) || estimateTokens(improved); const gradingPromptTokens = Number(graderResult.usage?.prompt_tokens) || estimateTokens( JSON.stringify({ originalPrompt, improvedPrompt: improved }) ); const gradingCompletionTokens = Number(graderResult.usage?.completion_tokens) || estimateTokens(graderResult.content); const promptTokens = improvementPromptTokens + gradingPromptTokens; const completionTokens = improvementCompletionTokens + gradingCompletionTokens; const totalTokens = Number(improvementResult.usage?.total_tokens || 0) + Number(graderResult.usage?.total_tokens || 0) || promptTokens + completionTokens; const tokenUsage = { promptTokens, completionTokens, totalTokens }; /* * Record the actual estimated/returned usage. */ await recordUsage(ip, totalTokens); /* * Store the object directly. * @upstash/redis handles JSON serialization. */ const cacheData = { improved, tokenUsage, grade }; await redis.setex(cacheKey, 3600, cacheData); return res.status(200).json({ improved, tokenUsage, grade, cached: false }); } catch (err) { console.error('Prompt improvement error:', err); return res.status(500).json({ error: `Server error: ${ err instanceof Error ? err.message : String(err) }` }); } }````javascript
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = Redis.fromEnv();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-20b';

// Application rate limits.
// These are usage-protection limits, not limits on the length of an individual prompt.
const LIMITS = {
  reqPerMin: 30,
  reqPerDay: 1000,
  tokPerMin: 12000,
  tokPerDay: 100000
};

const SYSTEM_PROMPT = `
You are an expert prompt engineer and senior software/AI engineering mentor.

Your job is to transform the user's raw prompt into a significantly better prompt that another AI can execute accurately.

IMPORTANT:
- Preserve the user's actual intent.
- Improve the prompt; do not merely rephrase it.
- Do not invent technologies, requirements, features, architecture, APIs, databases, services, or implementation details that the user did not request.
- When an important technical decision is unknown, explicitly mark it as [specify: X] instead of guessing.
- You may add useful constraints when they directly improve correctness, safety, or execution.
- Do not remove important requirements just to make the prompt shorter.
- Do not add unnecessary complexity.
- Make the resulting prompt actionable and unambiguous.
- If the user is asking for software development, clearly separate the goal, requirements, constraints, expected behavior, and deliverables where useful.
- Preserve existing technology choices when the user explicitly provided them.
- If no technology stack was specified, do not silently choose one.
- If the user wants to learn, make the AI act as both an expert implementer and a technical mentor.
- The improved prompt should tell the AI what to build/do, what decisions need to be explained, and what should be delivered.
- For security-sensitive or destructive operations, require confirmation before irreversible actions.
- Do not claim that something exists, has been tested, deployed, or verified unless the user explicitly said so.
- Avoid filler, repetition, marketing language, and unnecessary explanations.

OUTPUT FORMAT:
- Return ONLY the improved prompt.
- Do not explain what you changed.
- Do not wrap the prompt in Markdown code fences.
- Do not use asterisks for bold or emphasis.
- Do not use decorative Markdown.
- Do not add a "Here's your improved prompt" introduction.
- Numbered lists are allowed when they make instructions clearer.
- Use headings only when they genuinely improve organization.
- Do not impose an arbitrary word, character, or sentence limit.
- Use as much text as necessary to fully specify the user's request.
- At the same time, remove unnecessary verbosity and repetition.
- The final prompt should be complete rather than artificially short.
`;

const GRADER_SYSTEM_PROMPT = `
You are a strict prompt-quality evaluator.

Evaluate the improved prompt against the original prompt.

Score each criterion from 0 to 10:

1. Accuracy
Does the improved prompt correctly represent the user's request?

2. Hallucination
Does it avoid inventing unsupported technologies, requirements, facts, or assumptions?
10 = no problematic invention.

3. On-topic
Does it remain focused on the user's actual goal?

4. Token Efficiency
Does it remove unnecessary repetition and filler while retaining useful detail?
A longer prompt is NOT automatically inefficient if the extra detail is useful.

5. Clarity
Are the instructions unambiguous and easy for another AI to follow?

6. Actionability
Can another AI actually execute the request from the improved prompt?

7. Rule Adherence
Does the prompt follow the prompt-engineering rules, including preserving intent, avoiding unsupported assumptions, and handling unknowns appropriately?

Return ONLY valid JSON in this exact structure:

{
  "scores": {
    "accuracy": 0,
    "hallucination": 0,
    "onTopic": 0,
    "tokenEfficiency": 0,
    "clarity": 0,
    "actionability": 0,
    "ruleAdherence": 0
  },
  "feedback": "Brief explanation of the main strengths and weaknesses."
}

Do not return Markdown.
Do not wrap the JSON in code fences.
`;

function hashPrompt(prompt) {
  return crypto
    .createHash('sha256')
    .update(prompt)
    .digest('hex');
}

function estimateTokens(text) {
  if (!text) return 0;

  // Approximate token count.
  // Actual token usage is taken from the Groq API when available.
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

      // This is the model output allowance.
      // There is no application-level character/word limit.
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

  // Remove accidental surrounding Markdown code fences.
  cleaned = cleaned.replace(/^```(?:text|markdown)?\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  // Remove a common introductory phrase if the model ignores the
  // "return only the prompt" instruction.
  cleaned = cleaned.replace(
    /^(here(?:'s| is) (?:the )?(?:improved|optimized|refined) prompt:)\s*/i,
    ''
  );

  return cleaned.trim();
}

function clampScore(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(10, number));
}

function calculateTotalScore(scores) {
  const values = [
    scores.accuracy,
    scores.hallucination,
    scores.onTopic,
    scores.tokenEfficiency,
    scores.clarity,
    scores.actionability,
    scores.ruleAdherence
  ].map(clampScore);

  const rawScore = values.reduce((sum, value) => sum + value, 0);

  // 7 criteria × 10 = 70 maximum.
  // Normalize to a 0–100 grade.
  return Math.round((rawScore / 70) * 100);
}

function parseGraderResponse(content) {
  if (!content) {
    throw new Error('Grader returned an empty response.');
  }

  let cleaned = content.trim();

  // Remove Markdown code fences if the grader accidentally adds them.
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    // Try to extract the first JSON object.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Unable to parse grader JSON.');
    }

    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }

  const rawScores = parsed.scores || {};

  const scores = {
    accuracy: clampScore(rawScores.accuracy),
    hallucination: clampScore(rawScores.hallucination),
    onTopic: clampScore(rawScores.onTopic),
    tokenEfficiency: clampScore(rawScores.tokenEfficiency),
    clarity: clampScore(rawScores.clarity),
    actionability: clampScore(rawScores.actionability),
    ruleAdherence: clampScore(rawScores.ruleAdherence)
  };

  return {
    scores,
    totalScore: calculateTotalScore(scores),
    feedback:
      typeof parsed.feedback === 'string'
        ? parsed.feedback.trim()
        : ''
  };
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

    const promptHash = hashPrompt(originalPrompt);
    const cacheKey = `improve:${promptHash}`;

    /*
     * Upstash Redis automatically serializes/deserializes JSON-compatible
     * values. Therefore redis.get() may return an object directly.
     */
    const cached = await redis.get(cacheKey);

    if (cached) {
      let cacheData = cached;

      // Compatibility with any older cache entries that were stored
      // as JSON strings.
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
        await recordUsage(
          ip,
          Number(cacheData.tokenUsage?.totalTokens || 1)
        );

        return res.status(200).json({
          improved: cacheData.improved,
          tokenUsage: cacheData.tokenUsage || {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          },
          grade: cacheData.grade || null,
          cached: true
        });
      }
    }

    /*
     * STEP 1:
     * Improve the user's prompt.
     */
    const improvementResult = await callGroq([
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: originalPrompt
      }
    ]);

    const improved = cleanImprovedPrompt(improvementResult.content);

    if (!improved) {
      throw new Error('Groq returned an empty improved prompt.');
    }

    /*
     * STEP 2:
     * Grade the improved prompt against the original.
     */
    const graderResult = await callGroq([
      {
        role: 'system',
        content: GRADER_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: JSON.stringify({
          originalPrompt,
          improvedPrompt: improved
        })
      }
    ]);

    const grade = parseGraderResponse(graderResult.content);

    /*
     * Prefer actual Groq token usage.
     * Fall back to estimation if the API does not provide usage.
     */
    const improvementPromptTokens =
      Number(improvementResult.usage?.prompt_tokens) ||
      estimateTokens(originalPrompt);

    const improvementCompletionTokens =
      Number(improvementResult.usage?.completion_tokens) ||
      estimateTokens(improved);

    const gradingPromptTokens =
      Number(graderResult.usage?.prompt_tokens) ||
      estimateTokens(
        JSON.stringify({
          originalPrompt,
          improvedPrompt: improved
        })
      );

    const gradingCompletionTokens =
      Number(graderResult.usage?.completion_tokens) ||
      estimateTokens(graderResult.content);

    const promptTokens =
      improvementPromptTokens + gradingPromptTokens;

    const completionTokens =
      improvementCompletionTokens + gradingCompletionTokens;

    const totalTokens =
      Number(improvementResult.usage?.total_tokens || 0) +
      Number(graderResult.usage?.total_tokens || 0) ||
      promptTokens + completionTokens;

    const tokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens
    };

    /*
     * Record the actual estimated/returned usage.
     */
    await recordUsage(ip, totalTokens);

    /*
     * Store the object directly.
     * @upstash/redis handles JSON serialization.
     */
    const cacheData = {
      improved,
      tokenUsage,
      grade
    };

    await redis.setex(cacheKey, 3600, cacheData);

    return res.status(200).json({
      improved,
      tokenUsage,
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
