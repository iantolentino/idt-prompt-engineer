# Prompt Improver

Live app: https://idt-prompt-engineer.vercel.app/

A free, self-hosted tool that rewrites rough, messy instructions into precise, execution-ready prompts for coding agents (Claude Code, Codex, or similar). Paste a rough idea on the left, get a clean, structured prompt on the right, ready to copy and paste into whatever AI coding tool you use next.

This is not a general chatbot. It never answers your question or performs the task itself. Its only job is to take unclear input and turn it into a well-structured prompt for something else to execute.

## Why this exists

Rough instructions to a coding agent tend to cause problems: bundled unrelated fixes get merged into one vague ask, missing details get silently guessed instead of flagged, existing behavior gets modified when it should have been preserved, and the agent sometimes invents file or table names that were never mentioned. This tool applies a fixed set of rules, modeled on how a senior engineer writes a ticket, to catch and fix these issues before the prompt ever reaches the coding agent.

## How it works

1. You paste a rough instruction into the left panel.
2. The request goes to a serverless function, which sends it to Groq's free API along with a system prompt containing the rewriting rules.
3. The rewritten prompt comes back and displays on the right, along with real token counts from the API response.
4. A usage bar at the bottom tracks how close you are to Groq's free-tier limits, using a database that persists the count across sessions and devices.

No API key is stored or entered in the browser. It lives only in the server's environment configuration.

## The rewriting rules

The system prompt enforces the following, in order:

1. State the current problem before the fix, with the language, framework, or database integrated into that problem statement rather than added afterward.
2. Split bundled requirements into a numbered list. Each numbered item is a distinct action; constraints or qualifiers attach to the relevant step instead of becoming their own item.
3. Replace vague verbs such as "improve," "fix," or "make better" with the exact change needed.
4. Add concrete bounds wherever the original request is open-ended (limits, formats, versions, thresholds). Never invent a value; mark unknowns inline as `[specify: x]` within the step they affect.
5. State the language, framework, or database explicitly if it is given or reasonably inferable; flag it with `[specify: stack]` if not.
6. Preserve existing behavior, data, or naming unless the input explicitly says to change it. Add a "do not modify" line when relevant.
7. Never invent specific names that were not present in the input: no invented table names, column names, file names, function names, or API routes. Use `[specify: table names]` or similarly generic phrasing instead of guessing.
8. For database-related tasks, name only the tables or columns given in the input, require a rollback-safe or non-destructive approach whenever the step touches schema or existing data, and flag missing index or performance considerations with `[specify: expected data volume]` where relevant.
9. End with a one-line confirmation requirement, so the agent reports back exactly what it changed.
10. Cut every word that does not change what the agent will do. No pleasantries, no restated context, no filler, no trailing summary paragraph after the steps.

## What it will not do

It will not answer the question you asked. If you paste a request for something else entirely, such as "write me a README," it will still rewrite that as a prompt rather than producing the README itself. This is intentional; the tool has exactly one job.

## Tech stack

- Frontend: static HTML, CSS, and vanilla JavaScript, no framework
- Backend: Vercel serverless functions (Node.js)
- Model: Llama 3.3 70B, served through Groq's free API
- Usage tracking: Upstash Redis (connected through Vercel's storage integration), so request and token counts persist across sessions and devices rather than resetting per browser

## Project structure

```
index.html      the two-panel interface
script.js       handles the fetch calls and renders results
api/
  improve.js    receives the rough prompt, applies the system prompt, calls Groq, enforces usage limits
  usage.js      returns current usage counts without making a Groq call
package.json    declares the Redis client dependency
```

## Setup, if deploying your own copy

1. Push this repository to GitHub.
2. Import it into Vercel as a new project. The `api` folder is automatically detected and deployed as serverless functions.
3. In Vercel, go to Project Settings, Environment Variables, and add `GROQ_API_KEY` with a key generated from console.groq.com. This key never appears in the browser.
4. In Vercel, go to the Storage tab, browse the marketplace, and connect an Upstash Redis integration to the project. This automatically provides the environment variables the usage tracker needs.
5. Redeploy after both steps are complete, since environment variable and storage changes only take effect on the next deployment.

## Free-tier limits

Groq's free plan currently allows 30 requests per minute, 1,000 requests per day, 12,000 tokens per minute, and 100,000 tokens per day. The app checks these limits before every call and blocks the request locally with a clear message if you are about to exceed one, rather than letting the call fail with a server error. These figures are Groq's limits, not a cost to you; there is no billing involved as long as usage stays within them.

## Notes on the token counts shown

The input panel shows a rough estimate of your pasted text's token count. The output panel shows the real prompt and completion token counts returned directly by Groq's API, along with the difference between the rough input and the improved prompt. An improved prompt is often longer than the original, since it adds the structure and detail that was missing; this is expected and not a failure of efficiency.
