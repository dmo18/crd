---
name: owner-workflow
description: How to run any piece of work for this owner (a non-developer on a phone). Use for every feature, fix, redesign, deploy or server change, and when starting or taking over a project.
---

# Working method for this owner

The owner is not a developer and follows along on a phone. They judge by
results on the live site, not by code. Follow these steps for every job.

## 1. Understand before building
- Restate the request in one or two plain sentences. If the request is vague
  ("it's a fail"), ask for the top three concrete problems, with a screenshot
  if possible. Ask at most a few questions, once, each with a recommended answer.
- Look first: read the relevant code and docs, open the live site, check logs.
- For anything visual, look at how the best existing apps in that category do
  it and borrow what works. Phone first (360px wide), 44px tap targets.

## 2. One plan, one approval
- Write a short plan: numbered tasks, what the owner will see when each is
  done, anything that needs their clicks, and the risks.
- Get one approval for the whole plan. After that, run to the end without
  asking again unless something would change the plan or risk data.

## 3. Build safely
- Follow `CLAUDE.md` in the repository. Small commits with clear messages.
- Before each commit: `npm run check` (lint, types, tests). Never commit with
  a failing test. Never skip or disable a test to get green.
- Security is part of every task: validate outside input, no secrets in git
  or logs, least privilege, every page behind the owner session.
- Back up before schema changes or risky server changes: `sudo server-backup run`.
- No new dependency without a stated reason. Exact versions. Free tools only.

## 4. Prove it works
- Test the real thing the way the owner will use it: the live page on a
  phone-sized screen, the exact command from a normal account. A passing
  unit test is not proof that the screen works.
- If you could not verify something, say so plainly. Never report "done" on hope.

## 5. Report in a status block
Keep the owner informed with short blocks like this, in plain words:

```
DONE      Photo upload now shrinks pictures before saving
CHANGED   Scan screen: bigger shutter button, clearer error text
TRY IT    Open cards.moadab.com, tap Scan, take a photo of any card
NEXT      Price lookup for sealed boxes
NEEDS YOU Nothing
```

- Lead with what they can see or try. No jargon, no file names unless asked.
- Mistakes: say what went wrong, what you fixed, and how you tested the fix.
  No excuses, no padding.
- No em dashes or en dashes anywhere.

## 6. Keep the project memory current
- Update `docs/STATUS.md` after each finished job (progress, decisions, known
  issues) and `docs/PLAN.md` when the design changes.
- When the owner approves the live version, merge `live` into `main`.
