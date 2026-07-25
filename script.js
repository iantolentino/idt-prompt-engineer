const inputText = document.getElementById('inputText');
const outputText = document.getElementById('outputText');
const improveBtn = document.getElementById('improveBtn');
const inputMeta = document.getElementById('inputMeta');
const outputMeta = document.getElementById('outputMeta');
const usageBar = document.getElementById('usageBar');
const copyBtn = document.getElementById('copyBtn');

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.trim().split(/\s+/).length * 1.3);
}

function renderUsage(usage, limits) {
  usageBar.textContent =
    `Usage — this minute: ${usage.minute.requests}/${limits.reqPerMin} req, ${usage.minute.tokens}/${limits.tokPerMin} tok` +
    `  |  today: ${usage.day.requests}/${limits.reqPerDay} req, ${usage.day.tokens}/${limits.tokPerDay} tok`;
}

async function refreshUsage() {
  try {
    const res = await fetch('/api/usage');
    const data = await res.json();
    renderUsage(data, data.limits);
  } catch {
    usageBar.textContent = 'Usage unavailable';
  }
}

inputText.addEventListener('input', () => {
  inputMeta.textContent = `~${estimateTokens(inputText.value)} tokens (estimate)`;
});

improveBtn.addEventListener('click', async () => {
  const rough = inputText.value.trim();
  if (!rough) { alert('Paste a prompt to improve first.'); return; }

  improveBtn.disabled = true;
  improveBtn.classList.add('spinning');
  outputText.textContent = '';
  outputMeta.textContent = '';

  try {
    const response = await fetch('/api/improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: rough })
    });

    let data;
    const rawText = await response.text();
    try {
      data = JSON.parse(rawText);
    } catch {
      outputText.textContent = `Server error (not JSON): ${rawText.slice(0, 200)}`;
      return;
    }

    if (!response.ok) {
      outputText.textContent = `Free-tier limit or error: ${data.error || 'unknown error'}`;
      if (data.usage) renderUsage(data.usage, data.limits || {});
      return;
    }

    outputText.textContent = data.improved;
    document.getElementById('outputBadge')?.classList.add('active');

    const before = estimateTokens(rough);
    const after = data.tokenUsage?.completion_tokens ?? estimateTokens(data.improved);
    const diff = after - before;
    const diffLabel = diff === 0
      ? 'same length'
      : diff > 0
        ? `+${diff} tokens (more detail added)`
        : `${diff} tokens (tightened up)`;

    outputMeta.textContent =
      `Prompt tokens: ${data.tokenUsage?.prompt_tokens ?? 'n/a'} | ` +
      `Completion tokens: ${data.tokenUsage?.completion_tokens ?? 'n/a'} | ` +
      `Rough input: ~${before} tokens → Improved: ~${after} tokens (${diffLabel})`;

    renderUsage(data.usage, data.limits);

  } catch (err) {
    outputText.textContent = `Error: ${err.message}`;
  } finally {
    improveBtn.disabled = false;
    improveBtn.classList.remove('spinning');
  }
});

copyBtn.addEventListener('click', async () => {
  const text = outputText.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
  } catch {
    alert('Could not copy automatically — select the text manually.');
  }
});

refreshUsage();
setInterval(refreshUsage, 15000);
