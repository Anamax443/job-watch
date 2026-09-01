# JobWatch — design sheet

Written retroactively on 31 Aug 2026 against the [build specification](https://github.com/Anamax443/ai-agenti)
(phases F0 and F1). The agent had been running since 14 Jun 2026, so this document **did not precede
the build** — it describes what is actually in the code, and the numbers in it are measured on
production data, not estimated. Where something could not be measured, it says so instead of
leaving it out.

---

## Basics

| | |
|---|---|
| **What the agent does** | Every day it looks for vacancies of the type "IT manager / Head of IT / Solution Architect" in the South Moravian region, scores them against the owner's profile, and sends whatever passes the threshold to Telegram / e-mail / Slack. |
| **Owner** | Milan Trnka |
| **Definition of done** | Measurably: every ad from the watched sources that fits the profile reaches the owner **within 24 h of publication**, with no more than ~10 % false alarms. On the evaluation set this is **met as of 1 Sep 2026** (precision 100 %, effective recall 100 %); it is not verified across the whole market in production. |
| **Where it runs** | Cloudflare Worker + D1 + Cron, independent of any local PC. |

## Inputs

| Source | What it gives | Note |
|---|---|---|
| Labour Office (open data) | structured vacancy incl. occupation code, region and contact person | daily increments, full export ~184 MB (outside the Worker) |
| jobs.cz | targeted query search | no occupation code, so it bypasses the keyword test |
| prace.cz (LMC) | free search | broader; the prefilter trims the noise |
| Company ATS | ads straight from the employer | the registry is built by discovery |
| Web (Serper/Adzuna) | supplement | can be switched off in configuration |

## Scenarios

A closed list. **What is not in it, the agent cannot do and does not improvise.**

| # | Scenario | Triggered by |
|---|---|---|
| S1 | Daily run: fetch → prefilter → score → notify | cron 06:00 UTC |
| S2 | Scoring the backlog queue | part of S1 |
| S3 | Liveness check of an ad (has it disappeared?) | CI, daily |
| S4 | Manual run from the UI or Telegram (`/beh`) | human |
| S5 | List of current positions to Telegram (`/pozice`) | human |
| S6 | Status of the last run (`/stav`) | human |
| S7 | Manual bulk re-rating of ads (score 0) | human in the UI |
| S8 | Stopping a run | human (Stop / `/api/run/stop`) |

**How the user learns what the agent can do:** `/help` in Telegram, plus a help reply every time
it does not understand a command. A text interface has no buttons — it has to say so itself.

## Division of labour: model vs. code

The specification's rule: *if you are unsure about a step, it is code.*

| Step | Who | Why |
|---|---|---|
| Source selection, fetching, cursors | **code** | deterministic |
| Prefilter (role, region) | **code** | `src/prefilter.ts`; a model would be misled by the job title |
| Region decision | **code** | `src/region.ts` — the free model demonstrably ignored the instruction (a Prague ad scored 80/100 with the reasoning that it is in the preferred region) |
| Deduplication | **code** | three levels, `src/store.ts` |
| **Relevance score** | **model** | the only task code cannot do |
| Unmasking an agency | **model** | with `web_search`, paid backend only |
| Intent recognition in chat | **code** | `guessIntent`; a model would decide about starting a run without evals |
| Writes, notifications, kill switch | **code** | irreversible actions |

**The model has no direct access to any irreversible action.** It returns a number and a sentence;
what happens with them is decided by code.

## Gates (mode by reversibility of the error)

| Action | Reversible? | Mode |
|---|---|---|
| Writing a score to D1 | reversible (it will be rescored) | agent alone |
| Marking an ad as dead | reversible | agent alone |
| **Sending a notification** | **irreversible** | agent alone, but only above the threshold and capped at 10 messages per run |
| Bulk manual score of 0 | reversible | **human only** (row selection in the UI) |
| Changing the profile / settings | reversible | human only |
| Starting a run | reversible | human or cron |
| Stopping a run | — | human, in one action |

## Limits

| What | Value | What happens when exceeded |
|---|---|---|
| AI scorings per run | 150 | the rest waits in the queue, it is logged |
| Notifications from the queue per run | 10 | the next run sends the rest, it is logged |
| Liveness checks per run | 5 | the rest is handled by a GitHub Action |
| Run duration | 120 s | the run ends, the queue stays |
| Worker subrequests | platform cap | **the real throughput limit** — see F1 |

## Identity and AI disclosure

- UI access: Cloudflare Access **plus an allowlist in the application** (the perimeter alone is not enough).
- Telegram: replies only to the `chat_id` from Settings; a message from anyone else is discarded and logged.
- Every outgoing notification carries a sentence stating that it was composed by an automated system (AI Act).

---

# F1 — the measured core

Measured on 31 Aug 2026 against **production data**: 458 de-duplicated ads, 47 completed runs
since 1 Aug 2026. Not a sample, not synthetic.

## Accuracy

| Part | Result | How measured |
|---|---|---|
| **Deterministic core** (role prefilter + region) | **26/26 = 100 %** | `npm run evals` over `evals/skorovani.ts` — real ads with hand-written ground truth |
| **Model scoring** | **23/23**; precision 100 %, recall 100 %, effective recall 100 %, coverage 100 % | the "Measure model quality" button on `/tests` inside the deployed Worker, 1 Sep 2026, backend `anthropic 23x`, prompt `skore-2026-09-01.2` |

**Gate F1 holds as of 1 Sep 2026.** Until then the riskiest step — how well the model recognises
a match between an ad and the profile — had no number, and this document said so as a blind spot.
The measurement filled it in, and immediately showed why the number matters: **on the same set the
free model has 50 % recall, Claude 100 %**. The three real leads the free model scored zero on are
precisely the ones the agent exists for.

Two of those three were solved by the paid model. The third ("Head of IT" with no location) was not
— it fell only when the deterministic region cap was fixed, because the cap held an unverifiable
location permanently below the threshold. Had only the headline number been watched, it would have
looked like a single achievement of the model.

**What the number does NOT prove:** the negative class of the set is weak — 17 of 17 negatives have
`prefilter: "out"`, so in production they never reach the model. Precision of 100 % is therefore
largely a report card for the deterministic filter. Adding cases that pass the filter and still
have to score low is an open item.

## Cost

Inputs measured in production: system prompt **2,954 characters** (with the profile 2,081), ad
description on average **855 characters** (max 3,518), title 37 characters.

| Backend | Cost per ad | Per month (~1,950 ads) |
|---|---|---|
| **Workers AI (free)** | **CZK 0** | **CZK 0** — free tier of 10,000 neurons/day |
| Claude Haiku 4.5 (paid) | ~1,340 input + ~120 output tokens → **≈ USD 0.0019** | **≈ USD 3.7 / ~CZK 82** |

Haiku 4.5 pricing: USD 1.00 per million input and USD 5.00 per million output tokens. Tokens are
estimated from character counts at **3 characters ≈ 1 token** (Czech with diacritics); it is an
estimate, not a `count_tokens` measurement. Volume of 1,950/month = 65 candidates a day after the
prefilter × 30.

**Since 1 Sep 2026 the agent does pay** — after the measurement (free recall 50 %, Claude 100 %)
production switched to Claude, so the figure in the table is real, not hypothetical. Until then the
agent cost nothing and ran on the free backend.

## Time

| Metric | Value |
|---|---|
| Average run duration | **41.4 s** |
| Longest run | **120.0 s** — exactly the configured cap |
| Shortest run | 6 s |
| Completed successfully | **47 / 47** |
| Scored per run | **10–15 ads** (the configured cap is 150) |

**The finding that justifies the whole of F1:** the cap of 150 is never reached, because the
**Worker subrequest budget** runs out first — the run on 31 Aug at 06:00 died with
`Too many subrequests by single Worker invocation` after 15 scorings. Real throughput is therefore
~15/day, not 150/day, and a queue of 300 ads takes weeks to clear. That is a fundamental input for
any planning that had until then relied on the wrong number.

---

## What is missing against the specification

| Phase | State |
|---|---|
| F0 design sheet | ✅ this document (retroactively) |
| F1 measured core | ✅ time, cost and **model accuracy** all measured (1 Sep 2026) |
| F2 skeleton and contracts | ⚠️ there is no test environment without live delivery channels |
| F3 deterministic backbone | ✅ |
| F4 model and evals | ⚠️ prompt versioning, the eval set, defence against hostile input and the metrics are all in place; the model part however **cannot run in CI** (the free rung is the `env.AI` binding) — it is triggered by hand on `/tests` |
| F5 gates, limits, identity | ✅ |
| F6 failure, runbook, kill switch | ✅ |
| F7 deployment | ⚠️ no shadow run of a new version alongside the live one |
| F8 operation and growth | ⚠️ the set is fully green and has therefore stopped discriminating — it needs harder cases |

> **A finding for the build specification, not for the project.** Gate F4 requires "evals run in CI".
> For an agent whose default backend exists **only at runtime** (the Workers AI binding) that is
> unachievable: CI would measure a different model than the one that decides. The honest variant reads
> "evals on the deployed version, triggered manually, with a record" — and that is exactly how it is here.

---

*Czech original: [NAVRH.md](NAVRH.md) — the Czech version is authoritative.*
