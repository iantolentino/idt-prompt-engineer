# Prompt Improver

Live app: https://idt-prompt-engineer.vercel.app/

Paste a rough, messy idea into the left box. Get back a clear, well-organized instruction on the right, ready to hand to an AI coding assistant.

This tool has one job only. It does not write code, answer questions, or do the task itself. It only rewrites the instruction so whatever AI comes next understands it better.

## Why this exists

Messy requests to an AI cause predictable problems: several unrelated fixes crammed into one sentence, missing details getting silently guessed, or the AI inventing a file or table name that doesn't exist. This cleans up the request first, the way an experienced engineer rewrites a messy ticket before handing it off.

## The rewriting rules

1. State the current problem before the fix, with the language, framework, or database woven into that statement rather than tacked on afterward.
2. Split bundled requirements into a numbered list. Each item is a distinct action; constraints attach to the relevant step, never their own item.
3. Replace vague verbs like "improve" or "fix" with the exact change needed.
4. Add concrete bounds wherever the request is open-ended. Never invent a value; mark unknowns inline as `[specify: x]`.
5. State the stack explicitly if given; flag it with `[specify: stack]` only if genuinely not given.
6. Preserve existing behavior, data, or naming unless told otherwise. Add a "do not modify" line when relevant.
7. Never invent names, tables, files, or frameworks absent from the input.
8. For database tasks, name only what's actually given, require a rollback-safe approach when schema or data is touched, and flag missing performance considerations.
9. Propose exactly one technical approach per problem, never two competing fixes for the same issue.
10. If the stack is flagged unknown, the approach must stay generic too, no asserting stack-specific mechanisms in the same breath.
11. When the request names only a general capability ("search," "the list") with no domain stated, flag the domain itself instead of defaulting to the most common guess.
12. End with a one-line confirmation requirement.
13. Cut every word that doesn't change what the agent will do. No filler, no trailing summary.

## What it will not do

It will not answer the question you asked. Paste "write me a README" and it hands back a rewritten prompt for that task, not the README itself. That's intentional.

## Reliability, based on actual testing

Not a formal benchmark, just real test messages run against the live rules and graded by hand each time. Current standing:

| Area | Reliability | Notes |
|---|---|---|
| No fabricated names, tables, or frameworks | ~95% | Worst failure early on, fixed and held since |
| Action vs. constraint separation | ~95% | Clean since round two |
| Stack integration, no trailing sentences | ~95% | Fixed and held |
| Single coherent approach, no contradictions | ~90% | Fixed for the one case tested so far |
| Domain-ambiguity handling ("make it faster" with no context) | ~75-80% | Genuine weak spot; it now avoids inventing a mechanism but still leans toward naming one before the domain is confirmed |

Overall: ~90-97% reliable on concrete, well-described requests. Vague one-liners with zero domain context are the one pattern still worth double-checking before copying into an agent.

## Tech stack

- Frontend: static HTML, CSS, vanilla JavaScript
- Backend: Vercel serverless functions
- Model: Llama 3.3 70B via Groq
- Usage tracking: Upstash Redis, persists across sessions and devices

## Project structure

```
index.html      the two-panel interface
script.js       handles the fetch calls and renders results
api/
  improve.js    receives the rough prompt, applies the rewriting rules, calls Groq, enforces usage limits
  usage.js      returns current usage counts without making a Groq call
package.json    declares the Redis client dependency
```

## Notes on the token counts shown

The input panel shows a rough estimate of the pasted text's token count. The output panel shows the real prompt and completion token counts from Groq, plus the difference between rough input and improved prompt. An improved prompt is usually longer than the original since it adds the structure that was missing — that's expected, not a failure of efficiency.
