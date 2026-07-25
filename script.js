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

Example of correct behavior:
Rough input: "i need a script that cleans my csv removes duplicates and fixes
dates and should not crash if columns are missing use python"
Correct output:
"Write a Python script that processes a CSV file with these requirements:

1. Remove duplicate rows.
2. Standardize date-format columns to a consistent format.
3. If expected columns are missing, skip that step gracefully instead of
   crashing.

Use only Python standard library or pandas. [specify: exact date format,
input/output file paths]"

Output ONLY the rewritten prompt. No preamble, no explanation, no markdown
headers around the whole output — just the improved prompt text itself,
ready to copy and paste (the improved prompt may contain its own numbered
list as shown above).`;

const inputText = document.getElementById('inputText');
const outputText = document.getElementById('outputText');
const improveBtn = document.getElementById('improveBtn');
const inputMeta = document.getElementById('inputMeta');
const outputMeta = document.getElementById('outputMeta');
const apiKeyInput = document.getElementById('apiKey');

// Remember key in this browser only (localStorage), never sent anywhere but Groq
apiKeyInput.value = localStorage.getItem('groqApiKey') || '';
apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('groqApiKey', apiKeyInput.value.trim());
});

// Rough client-side token estimate (no API call needed for this one)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).length * 1.3);
}

inputText.addEventListener('input', () => {
  inputMeta.textContent = `~${estimateTokens(inputText.value)} tokens (estimate)`;
});

improveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const rough = inputText.value.trim();

  if (!key) { alert('Paste your Groq API key first.'); return; }
  if (!rough) { alert('Paste a prompt to improve first.'); return; }

  improveBtn.disabled = true;
  improveBtn.textContent = 'Improving...';
  outputText.textContent = '';
  outputMeta.textContent = '';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: rough }
        ],
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const improved = data.choices?.[0]?.message?.content?.trim() || '(no response)';
    const usage = data.usage || {};

    outputText.textContent = improved;

    const before = estimateTokens(rough);
    const after = usage.completion_tokens ?? estimateTokens(improved);
    const diff = after - before;
    const diffLabel = diff === 0
      ? 'same length'
      : diff > 0
        ? `+${diff} tokens (more detail added)`
        : `${diff} tokens (tightened up)`;

    outputMeta.textContent =
      `Prompt tokens: ${usage.prompt_tokens ?? 'n/a'} | ` +
      `Completion tokens: ${usage.completion_tokens ?? 'n/a'} | ` +
      `Rough input: ~${before} tokens → Improved: ~${after} tokens (${diffLabel})`;

  } catch (err) {
    outputText.textContent = `Error: ${err.message}`;
  } finally {
    improveBtn.disabled = false;
    improveBtn.textContent = 'Improve Prompt →';
  }
});
