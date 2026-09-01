# JobWatch — Handoff

Append-only state log. Newest entry on top. It exists so work can continue from another computer
or after a break. The factual "how it works" lives in [README.en.md](README.en.md); this is only
the **state**.

> **🟢 DEPLOYED AND RUNNING:** [jobwatch.maxferit.cz](https://jobwatch.maxferit.cz) behind Cloudflare
> Access, daily cron at 06:00 UTC (07:00 CET / 08:00 CEST). Repo **`Anamax443/job-watch`** (PUBLIC),
> branch `main`. Deploy runs from CI on push to `main` — **push = deployment**; since 22 Aug 2026 CI
> tells the truth (gate `typecheck` → `test` → deploy). Operation is independent of any local PC
> (Worker + D1 + Cron + GitHub Actions).

*The Czech [HANDOFF.md](HANDOFF.md) is authoritative. Entries from 30 Aug 2026 and earlier are
listed here as an index at the end; their full text is in the Czech original.*

---

## 2026-09-01 (5) — external review: four orchestration defects that 159 tests did not catch

An independent test against the `ai-agenti` methodology (dfd733c). **I verified the findings in the
code and all four hold.** They are not in the model, they are in the state machine around it — which
is worse, because the model at least has a measurement while these paths have nothing.

**1. All sources failing ends in a green run.** Adapters return `[]` on error, `timed()` returns the
`[]` fallback on timeout, and the final `flush(stats, true)` writes `ok = 1`. A run that brought
nothing because everything fell over looks exactly like a run on an empty market. There is no
`failed/degraded` state and no alarm. This breaks F3 ("two outcomes: it failed and you know, or it
went well").

**2. An unsent notification is never retried.** `pipeline.ts` sends after the score is written; when
no channel succeeds it logs `⚠️ not sent` and does **not** call `setNotified`. But the queue
(`loadUnscored`) only takes `relevance IS NULL OR rescore = 1`, so a scored, unsent ad never returns
to it. The agent can find the perfect job, fail to deliver it and never look at it again. (It stays
visible in the UI — but the notification is not retried.) The fix is an outbox with retry state and
an idempotency key.

**3. There is no run lock.** `POST /api/run` is a bare `ctx.waitUntil(runPipeline(env, 'manual'))` —
no lease, no mutex. Two requests = two concurrent runs. And it is worse than the review says: every
run starts with `clearStop(env)`, so **the second run erases the first run’s stop flag**. The kill
switch we fixed on 31 Aug can be bypassed this way without any ill intent.

**4. A stopped run is overwritten as successful.** Stop sets `ok = 0` with the condition
`WHERE finished_at IS NULL`. The pipeline then finishes and calls `flush(stats, true)`, which
unconditionally writes `ok = 1` `WHERE id = ?`. A stopped run therefore appears successful in the
history — which devalues the watchdog and the audit trail.

**And two errors in what I wrote yesterday:**

- **"16 of 17" was wrong; it is 17 of 17.** Re-measured over `evals/skorovani.ts`: `low+out 17`,
  `low+in 0`, `high+in 6`. The model therefore never sees a **single** hard negative case, and the
  claimed precision of 100 % says nothing about its ability to discriminate. I had published that
  number in six files; corrected.
- **The third-party text wrapper exists only in `score.ts`.** `wrapAd` appears exactly once in the
  repository. `enrich.ts` and `discover.ts` have their own `SYSTEM` constants outside `prompts.ts` —
  so no untrusted-data boundary, no `PROMPT_VERSION`, outside the CI gate. And those are precisely
  the paths that let the model onto foreign websites. Declaring the audit finding closed was
  premature. Corrected in README, STATUS and in the audit in `ai-agenti`.

**Other verified details:** the provider statistic is only filled on the queue path
(`pipeline.ts:527`); on the fresh-finds path (`:268`) `onProvider` is not passed, so "who scored it"
is incomplete. `detectPlatform` uses `host.includes('lever.co')`, which also accepts
`lever.co.evil.example`; the neighbouring Recruitee branch does it correctly with
`endsWith('.recruitee.com')`. `npm audit` over runtime dependencies is **clean (0)**; the 1 low +
5 high sit in the dev/deploy chain around Wrangler.

**Order of fixes** (from the review, and I agree with it): four operational acceptance tests — all
sources fail → `failed`; a failed send → the next run sends exactly once; two concurrent requests →
the second gets `409`; a stopped run stays `stopped`. Only then hard-negative evals and adversarial
cases for scoring, enrichment and discovery. **No new sources and no prompt tuning until that holds.**
---

## 2026-09-01 (4) — an ad without a location is no longer silently dropped; the set is 23/23

Commit `970fca8`, prompt `skore-2026-09-01.2`.

**The only FN of the last measurement was not a model error but a contradiction in the brief.**
`applyRegionGate` capped the `unknown` verdict at `threshold − 1`, i.e. ALWAYS below the
notification threshold — an ad with an empty location field could therefore never pass, whatever
score it got. Yet the justification of that very case in the eval set reads "an unknown region must
NOT be discarded, a lead should not be lost because of an empty field". Code and intent contradicted
each other, and the measurement brought it to light.

**I first tried to derive the region from the description text.** I wrote it with tests and then threw
it away, because the real sample refuted it: of 283 active ads, **5 have an empty location and 4 of
them name no town even in the description** (one of them 3,518 characters and nothing); the fifth
mentions Prague and is a Prague role, so the current "do not send" is correct. **That branch would not
have changed the outcome for a single one of the five.** A lookup in the company registry by company
ID would have fared worse — these are consultancies and agencies (Accenture twice, IBS, Ipsos,
Snapstack) where the registered seat says nothing about the place of work; it would have produced
Prague systematically.

That left a choice between a silent loss and a question mark. At 5 out of 283 (1.8 %) the question
mark is cheaper:
- `unknown` **does not lower the score**, it only gets `⚠️ location not stated` in the justification —
  visible in the app, the console and the e-mail;
- **it had to change in the prompt as well.** Changing the cap alone would have done nothing: those
  ads were getting 0–30 from the model itself, because the prompt told it "such an ad must not pass
  the threshold on content alone". The cap never came into play. The new sentence: the code decides
  what happens with an unverified location, the model is to judge the content of the role only;
- `out` is still capped at 40, hard and unchanged.

**Side finding:** the register of regions in `region.ts` knows nominative forms only — the Czech
locative "v Brně" does not match the alias "brno". That is what my first derivation test failed on.
If prose is ever parsed, this has to be solved first.

**Re-measured after deployment: 23/23**, precision 100 %, recall and effective recall 100 %, coverage
100 %, `anthropic 23x`. "Head of IT" flipped to 75. None of the Prague cases moved above the threshold
(40 at most, the `out` cap), so there is no regression.

**What this does not prove:** the negative class is still degenerate (17 of 17 negatives have
`prefilter: "out"`) and a fully green set has stopped discriminating. It needs harder cases — Brno ads
where the outcome is decided by the role, not the region. Candidates pulled from D1 are waiting for
hand-written labels: Red Hat Senior SW Engineer, Asseco Customer Experience and delivery, FNZ Director
of Equity Compensation, Kyndryl Unified Systems Operations, Zebra and Jamf Manager Software
Engineering, Atlas Copco IT Product Owner.

---

## 2026-09-01 (3) — own Anthropic key: production runs on Claude and it is measured for the first time

The key from a shared organisation with no credit (`be25a427…`) was replaced by an own key in
organisation `391fd499…`. Verified by a **billable** `messages.create` call with `max_tokens: 1`, not
via `GET /v1/models` — that one is free and passes even without credit, so the indicator would show
false green. Both models the agent actually uses were verified as well: `claude-haiku-4-5` (scoring)
and `claude-sonnet-4-6` (de-anonymisation).

Deployed as a Worker secret (`Secret Change`, version `2477def5`, 100 % of traffic). In Settings
`aiProvider` switched to `anthropic`.

**The first run after the switch proved nothing** — `scored: 0`, because all 14 candidates had already
been scored by the previous run and dedup correctly skipped them. Claude was never called. Deploying
the secret is not by itself proof that the paid path works; the proof came only from the set on
`/tests`.

**Comparison on the same set of 23 cases:**

| | free Workers AI | Claude |
|---|---|---|
| Precision | 100 % | 100 % |
| Recall | **50 %** (TP 3 / FN 3) | **83 %** (TP 5 / FN 1) |
| Effective recall | 50 % | 83 % |
| Coverage | 100 % | 100 % |

The free model gave zero to three real leads: "Druhý muž IT" (0 → 78 with Claude), "Manažer
kybernetické bezpečnosti" (0 → 72) and "Head of IT" with no location (that one fell only when the
region cap was fixed — see the entry above). **This is the first time the paid backend is justified by
numbers rather than by faith.**

A note on the honesty of the comparison: the prompt also changed between the two runs
(`skore-2026-08-31.1` → `skore-2026-09-01.1`), so it is not a clean experiment. The 50 → 83 gap is too
large for the prompt to explain, but it could be isolated by switching to `workers-ai` and measuring
again on the same prompt.

---

## 2026-09-01 (2) — third-party text in the prompt gets a wrapper; evals measure the selected backend

Commits `7b1643d` and `01faed9`. Closes findings 3 and 4 of the audit against the build specification.

**The set was measuring a different backend than the one running.** `runEvals` did not pass the
backend choice to `scoreJob`, so `providerChain` treated it as "auto" = **Workers AI only**. The
measurement returned `workers-ai 23x` at a moment when paid Claude was selected in Settings. The
pipeline does it correctly (`effectiveProvider` + passing it into `scoreJob`); the set did not. A
regression test with the `off` choice fails without the fix.

**The metrics got their second half.** Added `coverage` (how many cases the model answered at all) and
**effective recall**, where a non-answer on an expected lead is a lost lead, not an excluded case.
Without it, a model that stays silent on six leads out of seven and hits the seventh reports 100 %
recall.

**Region and threshold are taken from the set**, not from live Settings — the hand-written labels
depend on them ("Prague → low" holds only while the preferred region is Brno and the threshold is 70).
The profile stays live, but its fingerprint and length go into the result, so the record shows that
the measurement ran against a different brief than the one the labels were written for.

**Defence against hostile input.** The ad description is delimited by an `<inzerat>` tag and the
system prompt states that there are no instructions inside; a closing tag in the input is neutralised
so it cannot be escaped. Until then the damage was bounded only by the JSON schema and the region cap
— which was luck of the design, not a defence. Guarded by `tests/prompt-injection.test.ts`.

**`npm run evals`** no longer ends with the summary "Evals passed" when the model part never ran.

---

## 2026-09-01 — the evals were measuring the wrong rung of the ladder; now they measure the deciding one

**An external review found the sharpest thing:** the set in `scripts/evals.ts` called Anthropic
directly, while production scored via free Workers AI by default. It was therefore measuring a model
that does not decide today. That is not a missing measurement but **an instrument pointed at the wrong
thing** — it manufactures false confidence, which is worse than none.

**A correction from the owner that sharpened the diagnosis:** there is not one production model, there
is a **ladder** (paid Claude → free Workers AI). That is by design and follows the rule "an AI layer
never without a fallback". What was missing is the second half of that rule — **"and it is visible"**:

- nowhere was it recorded **which rung produced which score**; an 80 from Claude and an 80 from Llama
  8B looked identical in the database,
- **a successful switch to the fallback was not logged** — only failures, and those capped at three
  messages per run. "Credit ran out, the free model has been scoring all month" was effectively
  invisible.

**What was added:**

- `onProvider` in `scoreJob` — a hook called on SUCCESS, reporting who answered.
- `runs.stats.providers` + a 🧠 line in the run log: "Scored by: … 27x", and when two rungs appear in
  one run it explicitly says a fallback happened.
- `src/evals.ts` + `POST /api/evals` — the set runs **inside the deployed version** through the same
  `scoreJob`, prompt and ladder as production. There is no other way: the free rung is the `env.AI`
  binding, which does not exist from Node or CI.
- **Precision and recall**, not just a share of correct guesses. The set has 16 of 23 cases negative,
  so "70 % correct" would look fine even for a model that sends nothing at all. An unanswered case
  does not count towards accuracy — a backend outage is not a bad rating.
- A **"Measure model quality"** button on `/tests`, separate from the self-check: that guards code
  invariants (fast, free, automatic), this measures the model (slow, costs calls, manual).
- `scripts/evals.ts` no longer measures the model at all and **says why** — unmeasured must not look
  like passed.
- The set converted from JSON to a TS module (`evals/skorovani.ts`): both Node and the Worker read it,
  and two copies would drift apart.

5 tests for precision/recall (**154** in total).

**What this does not close:** the measurement is still manual and does not run in CI. But for the first
time it measures what actually decides — and says which rung it was.

---

## 2026-09-01 — invariants from two days of debugging added to /tests

Most of what today uncovered lived only in `tests/` and in CI. It was not visible on the deployed
version — and the difference between "the commit passed" and "it holds for what is running right now"
is the whole point of that page. The self-check grew from **42 to 68 checks**, in three groups:

**Prefilter** (+5): jobs.cz passes without the keyword test (the ARKYS case — without that pass, 16
real Brno ads dropped out), "CIO" does not catch the Czech word for day-care centre, Prague from
jobs.cz does not pass (cut by the region, not the role), an unknown location is not discarded, and
role × region are two different decisions — swapping them means debugging the wrong cause.

**Budget meter** (4): a batch counts as ONE request (otherwise the optimisation would look
ineffective), a single query counts, the budget reports two different numbers (per processed item vs.
per item scored by the model) and admits that it does not measure source fetching.

**Run state** (4): an unfinished run is neither ✅ nor ❌, broken statistics do not break the response,
the watchdog waits longer than a run takes (6 min vs. 60 s — a shorter bound would close live runs)
and the prompt carries a version.

**Alongside that, a fix the user pointed out:** the documentation said "daily cron 07:00 CET". CET only
holds in winter — in summer it runs at 08:00 local time. That figure had been lying for half a year.
Corrected to "06:00 UTC (07:00 CET / 08:00 CEST)" in README, HANDOFF, STATUS and wrangler.toml.

---

## 2026-09-01 — run 132 was KILLED by the platform; a watchdog for unfinished runs was added

After raising the budget to 120 s, the Telegram-triggered run (132) **did not finish**: started
05:20:44, six minutes later still `finished_at = NULL`, `ok = 0`, `budget` missing from `stats`. The
log ends exactly at the liveness line, i.e. **at the start of draining the queue** (129 waiting).

**What matters is how it failed.** It did not throw — the platform terminated the invocation. So no
`catch` ran, yesterday’s crash alert never fired, `finished_at` was never written, and an open record
stayed hanging in the table. From the outside it looks like the agent is still working. Exactly the
class of failure gate F6 is meant to catch — just one floor above where I reached yesterday: `catch`
catches thrown errors, not an external kill.

**Fix 1 — a watchdog.** `uzavriZombie()` runs on the five-minute schedule (the only thing that looks
regularly). An open record older than 6 minutes is closed, a 💀 explanation is written into its log and
**a message goes to Telegram**. The bound is deliberately longer than the run budget, so the watchdog
does not close a run that is still alive.

**Fix 2 — budget back down to 60 s.** A killed run writes **nothing**; a short one writes what it
managed and the rest is caught up by the next. More short runs are therefore better than one long one
that does not survive. Applies to cron and Telegram alike.

**A note on yesterday’s diagnosis:** for the second time it turned out the brake is not the subrequest
budget. First it was the 26-second budget of a manual run, now the invocation cap. The real limit is
still unmeasured — the meter will show it once a run completes.

6 tests over a D1 stub (**148** in total), among them that the watchdog does not touch data when there
is no zombie, and that a nonsensical bound is normalised to a minute so it cannot close a running run.

---

## 2026-09-01 — the meter refuted my diagnosis; the real brake was elsewhere

The first run on a full queue (131, started from Telegram, 145 waiting):

```
fetched 100 · candidates 14 · scored 8 · prefiltered 15 · queueDepth 129
📶 D1 67 · model 1 · liveness 5 = 73 · per scored ad 9.13
run took 23 s
```

**The claim "free plan = 50 subrequests and that is the brake" DOES NOT HOLD.** The run spent 73 and
finished comfortably. That "35 ÷ 2.7 = 13" came out and matched the observed 10–15 was a coincidence.
The `Too many subrequests` error of 31 Aug is real, but the cap is elsewhere and its value is not yet
known. A diagnosis built on static analysis of the code failed **for the third time in one day** —
hence the meter.

**The real brake: a manual run has a 26-second budget.** Which makes sense — the browser page calls it
again in a loop up to 25 times. But **nobody loops the `/beh` command from Telegram**, so it did one
portion and stopped: out of a queue of 145 it handled 16 and finished in 23 s. Fixed by introducing a
third trigger `telegram`, which gets the same budget as cron (120 s).

**Second error: "Scored from queue: 8" was lying.** The model touched **one** ad; the other 7 were
excluded by code. `backlog` was counting deterministic exclusions as well. Split into `progressed`
(rows left the queue — drives the loop and the "three batches without a result" guard) and `scored`
(the model’s work — goes into the summary). A sum that mixes the model’s work with the code’s work
misleads exactly where it should be visible what cost money.

**What the meter did confirm:** D1 is 67 of the 73 requests. The database is by far the largest item,
so batched writes do make sense — they just were not what slowed that particular run.

**What else the run revealed:** the prefilter cut 86 of 100 fetched (jobs.cz 47, prace.cz **all 39**) —
that is the hard region filter and it is intended. The Labour Office returned HTTP 404 for 1 Sep, the
cursor stayed at 31 Aug (expected behaviour, the increment is not published yet).

---

## 2026-08-31 — budget meter: the run counts its own subrequests

Until now the budget consumption was **estimated from static analysis of the code**. That is counting
on paper — and as today showed twice, paper tolerates a wrong number too. `src/metrics.ts`:

- `wrapDb()` wraps D1 at the start of a run, so **every** call is counted without touching the call
  sites. A batch counts as **one** item — that is the whole point of batching. Statements are unwrapped
  back to the originals before being passed to `batch()`, otherwise D1 would reject them.
- Model calls and HTTP liveness checks are counted separately.
- The result goes into `runs.stats.budget` and into the run log as a 📶 line, including **consumption
  per scored ad** — that is the number that tells whether an optimisation helped.
- It is also visible in Telegram via `/stav`.

**What is deliberately not measured:** fetching the sources (`fetch` inside `src/sources/*`). The
global `fetch` cannot be wrapped safely — an isolate shares several concurrent invocations. The log
line **admits** it, because a total without that note would read as complete and a person would
conclude there is more headroom than there is.

**What it is immediately good for:** it will confirm (or refute) today’s diagnosis. By calculation,
after batched writes it should come out at about 1.3 requests per ad and ~27 scored. If the meter shows
something else, the diagnosis is wrong, not the agent.

6 tests over a D1 stub (**142** in total), among them that originals and not wrappers reach `batch()`.

---

## 2026-08-31 — throughput: writing to D1 one row at a time ate the Worker budget

**Diagnosis.** The Worker has a cap on subrequests per invocation — **50** on the free plan — and
**D1 calls count towards it**, not just HTTP. The breakdown per scored ad in the queue was:
`loadUnscored` 0.33 + model 1.0 + `updateScore` 1.0 + `run.flush` 0.33 = **2.7 requests**. Fixed run
overhead (fetching sources ~10, liveness 5) takes 15, leaving 35, and 35 ÷ 2.7 = **13 ads**. Exactly
what the runs had been doing all along (10–15).

The `MAX_SCORES_PER_RUN = 150` cap therefore never applied — a different, unnamed limit was binding.

**The worst piece was my own from this afternoon:** deterministic exclusion from the queue wrote
`updateScore` **one row at a time**. For 300 junk rows in the queue that would spend the entire budget
on cleanup and leave nothing for scoring.

**Fix — `bulkUpdateScores()`.** `DB.batch()` is one round-trip, so a batch of 40 writes costs **one**
subrequest instead of forty. Wired into both places (exclusion and scores), and the queue batch grown
from 3 to 8 so the read amortises too.

| | before | after |
|---|---|---|
| requests per ad | 2.7 | **1.3** |
| scored per run | ~13 | **~27** |

**Where the hard floor is.** One ad = one model call, and that cannot be reduced. The free-plan cap
therefore holds throughput below ~35/run **however the code is optimised**. Anyone wanting more has to
move to **Workers Paid (USD 5/month)**, where the cap is 1,000 requests — only there does
`MAX_SCORES_PER_RUN = 150` become the real limit. That is a decision about money, not about code.

---

## 2026-08-31 — F0 + F1: design sheet and measured core (NAVRH.md)

Added retroactively — the agent has been running since 14 Jun 2026, so the design sheet did not precede
the build. It describes what is actually in the code, and the numbers are **measured on production
data** (458 ads, 47 completed runs since 1 Aug), not estimated.

**F0:** a closed list of 8 scenarios, a model × code table (the rule "if you are unsure, it is code" —
the model was left with one thing only: the relevance score), gate modes by reversibility of the
action, limits, identity. It also writes down **when the agent is done** measurably — and that this is
not yet verified.

**F1 — time.** Average run 41.4 s, longest 120.0 s (exactly the configured cap), 47/47 completed.

**F1 — cost.** Prompt 2,954 characters, ad description 855 on average (max 3,518). On the default free
backend (Workers AI) the agent **pays nothing**. Switched to Claude Haiku 4.5 an ad costs ~USD 0.0019,
i.e. ~USD 3.7 (~CZK 82) a month at 1,950 ads. Tokens estimated from character counts at 3:1 — an
estimate, not a `count_tokens` measurement.

**F1 — accuracy.** Deterministic core **26/26 = 100 %**. Model scoring **NOT MEASURED** — the model
part of the evals needs a key that is not in CI. **Gate F1 therefore does not hold**, and NAVRH.md says
so as a blind spot rather than leaving it out.

**The finding that justifies the whole of F1:** the `MAX_SCORES_PER_RUN = 150` cap is never reached,
because the Worker subrequest budget runs out first — the run of 31 Aug at 06:00 died with "Too many
subrequests" after 15 scorings. **Real throughput is ~15/day, not 150/day.** Any planning that relied
on the latter was off; a queue of 300 ads takes weeks, not two days.

---

## 2026-08-31 — F4: the prompt carries a version, evaluation set from real ads

- `src/prompts.ts` — prompts moved out of `score.ts` into one place, texts unchanged.
  `PROMPT_VERSION` is written into `runs.stats.promptVersion`.
- `npm run check:prompt` — a CI gate: if the prompt file changes and the version does not, the
  deployment fails. Without it, stored runs would hold two wordings under one number. The check is a
  pure function `needsVersionBump(diff)`, with 5 tests on it.
- `evals/skorovani.json` — **26 real ads** from the production D1 with hand-written ground truth. Each
  one records WHY it is there; most came from a specific incident (Prague at 80/100, "CIO" inside the
  Czech word for day-care centre, a warehouse labourer, ARKYS thrown out by a tightened prefilter).
- `npm run evals` — the deterministic part (prefilter, region) always runs and is a CI gate: **26/26**.
  The model part needs `ANTHROPIC_API_KEY`, so it is loudly skipped in CI — "could not be measured"
  must not look like "passed".

**State against the build specification after today:** F3 ✅, F5 ⚠️→✅ (AI disclosure added), F6 ✅
(kill switch and crash alerting), F4 ⚠️ (version and set exist, the model part of the evals does not
run in CI yet). Remaining: F0 (design sheet), F1 (measured core) and F7 (a new version running blind
alongside the live one).

---

## 2026-08-31 — FIXING MY OWN MISTAKE: tightening the prefilter was discarding real leads

**What happened.** In the afternoon I removed the `j.source === 'jobs.cz'` pass in the prefilter, on
the grounds that "139 out-of-field ads fell out of the listing". **That number was miscalculated.** It
came from a query for records without `CzIsco/133` — but jobs.cz ads have no occupation code **at
all**, so every single one of them landed in that number. Nothing was left of the 139 "pieces of
evidence".

**What it would have cost.** Measured over all 458 real records using the actual `roleMatch` function:
without the pass, **16 relevant Brno ads** would have dropped out, among them

- "IT Specialista / Architekt — Druhý muž IT" (ARKYS, Brno) — **score 80**
- "IT Product Owner, Manager – Order Management" (Atlas Copco, Brno) — 60
- "Manažer kybernetické bezpečnosti" (SZPI, Brno)
- "Senior IT konzultant" (bezva IT partner, Brno)
- "Správce ICT" (Masaryk University, Brno)
- "IT projektový/á manažer/ka" (RegioJet, Brno)

Portal titles almost never read like a keyword from the list, so the keyword test does not reach them.
Worse than mere non-display: the deterministic queue exclusion introduced today would have given them
**score 0** on the next run with the reason "outside the searched role".

**Fix.** The `jobs.cz` pass restored. After the fix only 4 records drop out on role grounds, and all of
them are also outside the region or genuinely out of field.

**What still holds.** The noise from the Labour Office that prompted the tightening had a different
cause — substring matching of a keyword ("CIO" inside the Czech word sta-CIO-nář). That fix stays, as
does the hard region filter; **Prague from jobs.cz is cut by the region, not by the role**, and that is
the right mechanism.

**A lesson for the specification.** This is exactly what phase F1 ("measure the core on a real sample")
and F4 (the evaluation set) are meant to catch. The mistake survived only because the change leaned on
a SQL aggregate instead of a pass through the real function over real data. The check now lives in
`tests/prefilter.test.ts` as a named ARKYS case.

---

## 2026-08-31 — F6: the kill switch really kills, a crash reaches a human, messages disclose AI

A retrofit against the build specification from `ai-agenti`. The project is older than that framework,
so it is not being rebuilt — it is being completed piece by piece so the agent keeps working meanwhile.

**Finding 1 — the kill switch did not kill.** `POST /api/run/stop` did one thing: `UPDATE runs SET
finished_at`. It closed the *record* of the run, not the run. The pipeline read no flag (`grep -i stop`
returned zero hits) and kept scoring and sending notifications. The button was lying.

- The flag lives in `meta` under the key `run_stop` — **deliberately without a migration**, a kill
  switch must not wait on a change to the live database.
- The run reads it before every batch of candidates and in every round of the queue, and skips liveness
  verification.
- A stopped run is reported in the log and summary as ⏹️, not ✅. The difference between "completed" and
  "stopped" has to be visible.
- The flag is cleared at the start of a run, otherwise an old press would kill the next one.
- **A trap I nearly fell into:** the "Run now" loop calls the same endpoint with `?auto=1` after every
  batch. If the flag were raised there too, it would stop itself. It is only raised without `auto`.

**Finding 2 — a crashed run was silent.** `catch` wrote the error to the log and rethrew it; `notify()`
was called only for leads. "Found nothing today" and "it crashed today" therefore looked identical from
the outside, and the agent could be dead for a week. Now a message goes from `catch` to Telegram with
the error and with what the run managed. A failure of that alert does not override the original error.

---

## Index of older entries

Full text in the Czech [HANDOFF.md](HANDOFF.md), which is authoritative. One line each, newest first.

| Date | Entry |
|---|---|
| 2026-08-31 | **A run can be started from Telegram** (`/beh`, `/stav`) — with a guard against double starts; `/start` deliberately starts nothing and returns help. |
| 2026-08-31 | **Manual bulk scoring** — filter the overview, tick rows, set 0. A human-only action; `rescore = 0` so the loop does not undo it. |
| 2026-08-31 | **The prefilter leaked**: "CIO" was matched as a substring and hit the Czech word sta-CIO-nář, so care workers entered the queue; jobs.cz had a pass that also let Prague through. |
| 2026-08-31 | **Telegram can answer**: `/pozice` returns current roles above the threshold; intent is parsed by code, not by a model. |
| 2026-08-31 | **Min. score was silently discarding the queue too** — no comparison holds for `relevance IS NULL`, so a threshold of 1 filtered as hard as 100. Added an "incl. history" toggle. |
| 2026-08-31 | **Older ads were unreachable from the UI** although they were in D1 the whole time — paging by 200 plus a "Load older" button; 258 records from 14 Jun to 13 Aug had been invisible. |
| 2026-08-31 | **Liveness of portal ads got its own run** in CI — the Worker has a subrequest cap, CI does not; 60 checks in a run had knocked queue draining down to "Too many subrequests". |
| 2026-08-30 | **Audit against the build specification: four findings** — a kill switch that did not stop, a silent crash, third-party text entering the model unwrapped, an unmeasurable prompt. All closed by 1 Sep 2026. |
| 2026-08-23 | **The queue was not shrinking** — the subrequest budget ran out, not the time. Liveness checks were eating it. |
| 2026-08-23 | **The profile in Settings rewritten from a CV into a brief** — with exclusion criteria and admitted gaps. The cheapest fix was not in the code but in the brief. |
| 2026-08-22 | **Finding from production data: scoring had no scale** — 12 of 13 above the threshold scored exactly 100. The cause was the profile, not the model. |
| 2026-08-22 | **Identity in the header, min. score into Settings, the `/tests` page** — invariants running on the deployed version, not only in CI. |
| 2026-08-22 | **The application verifies identity, not just the perimeter** — all of `/api` including reads is protected and the header value is checked against an allowlist. |
| 2026-08-05 | **State before this** (reconstructed from git history) — including the workers.dev finding: a second, unprotected address of the same Worker allowed read APIs to be downloaded without logging in. |

---

## Redeploy / new version

`git push` to `main` = deployment (GitHub Actions `deploy.yml`, gate `typecheck` → `test` → deploy).
Manually from a PC: `npm run deploy` with `CLOUDFLARE_ACCOUNT_ID` pinned — the bass443 login sees
several Cloudflare accounts, and without the account ID a non-interactive `wrangler deploy` fails on
`/memberships`. After deploying, wait for the edge to catch up before declaring anything about the
state, and check the commit in the page footer (`/api/version`).
