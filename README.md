# Prompt Improver

Live app: https://idt-prompt-engineer.vercel.app/

Type a rough, messy idea into the left box. Get back a clear, well-organized instruction on the right that's ready to hand to an AI coding assistant. Think of it as a translator between "what you're thinking" and "what an AI needs to hear to actually get it right."

This tool has one job only. It does not write code, answer questions, or do the task itself. It only rewrites your instruction so that whatever AI you use next understands it better.

## Why this exists

When people ask an AI to fix or build something, the request is often messy: several unrelated fixes crammed into one sentence, important details left out, or the AI ends up guessing things that were never actually true, like a file or table name that doesn't exist. Those small mistakes cause real problems later. This tool cleans up the request first, the way an experienced engineer would rewrite a coworker's messy ticket before handing it off, so the AI has less room to get confused or make things up.

## How it works

1. Paste a rough instruction into the left panel.
2. It goes to a serverless function, which sends it to Groq's free API along with a system prompt containing the rewriting rules below.
3. The rewritten prompt comes back on the right, along with real token counts from the API response.
4. A status bar at the bottom tracks usage against Groq's free-tier limits, backed by a database that persists the count across sessions and devices, not just one browser.

No API key ever touches the browser. It lives only in the server's environment configuration.

## The rewriting rules

The system prompt enforces the following, in order:

1. State the current problem before the fix, with the language, framework, or database woven into that problem statement rather than tacked on afterward.
2. Split bundled requirements into a numbered list. Each item is a distinct action; constraints or qualifiers attach to the relevant step instead of becoming their own item.
3. Replace vague verbs such as "improve," "fix," or "make better" with the exact change needed.
4. Add concrete bounds wherever the request is open-ended. Never invent a value; mark unknowns inline as `[specify: x]` within the step they affect.
5. State the language, framework, or database explicitly if given or reasonably inferable; flag it with `[specify: stack]` if not.
6. Preserve existing behavior, data, or naming unless told otherwise. Add a "do not modify" line when relevant.
7. Never invent specific names absent from the input. No invented tables, columns, files, functions, or routes. Use `[specify: table names]` instead of guessing.
8. For database tasks, name only the tables or columns actually given, require a rollback-safe approach whenever schema or existing data is touched, and flag missing performance considerations with `[specify: expected data volume]`.
9. End with a one-line confirmation requirement, so the agent reports back exactly what it changed.
10. Cut every word that doesn't change what the agent will do. No pleasantries, no filler, no trailing summary paragraph.

## What it will not do

It will not answer the question you asked. Paste a request for something else entirely, like "write me a README," and it will still hand you back a rewritten prompt for that task rather than the README itself. That's not a bug. It has exactly one job, and it stays in its lane.

## Tech stack

- Frontend: static HTML, CSS, and vanilla JavaScript, no framework
- Backend: Vercel serverless functions (Node.js)
- Model: Llama 3.3 70B, served through Groq's free API
- Usage tracking: Upstash Redis, connected through Vercel's storage integration, so counts persist across sessions and devices

## Project structure

```
index.html      the two-panel interface
script.js       handles the fetch calls and renders results
api/
  improve.js    receives the rough prompt, applies the rewriting rules, calls Groq, enforces usage limits
  usage.js      returns current usage counts without making a Groq call
package.json    declares the Redis client dependency
```

## Testing notes

This system prompt went through several rounds of real, manual testing during development, not an automated benchmark. Each round used the same or similar test messages and graded the output against a fixed checklist: correct problem statement, numbered actions only, no fabricated names, stack integrated up front, database constraints handled correctly, and a specific confirmation line. Early versions scored in the 70s, mainly due to invented table names and constraints being listed as separate steps instead of qualifiers. Fixing the fabrication rule and lowering the model's temperature closed most of that gap.

The highest score recorded was 94/100, tested on a real messy example combining a login bug, a rate limiting request, and an outdated password reset system.

It scored high because it correctly separated the three issues, kept the tech stack and the "don't touch this" warning in the right place, and never invented any names or details that weren't actually mentioned. The few points lost were for smaller things, like the closing confirmation line being a bit generic instead of restating exactly what was done.

## Free-tier limits

Groq's free plan currently allows 30 requests per minute, 1,000 requests per day, 12,000 tokens per minute, and 100,000 tokens per day. The app checks these before every call and blocks locally with a clear message if you're about to exceed one, instead of letting the call fail with a server error. These are Groq's limits, not a cost to you. There is no billing involved as long as usage stays within them.

## Notes on the token counts shown

The input panel shows a rough estimate of your pasted text's token count. The output panel shows the real prompt and completion token counts returned directly by Groq, along with the difference between the rough input and the improved prompt. An improved prompt is often longer than the original, since it adds the structure and detail that was missing. That's expected, not a failure of efficiency.
