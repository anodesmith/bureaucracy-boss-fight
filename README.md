# Bureaucracy Boss Fight 🇰🇪

**Kenyan life has become a strategy game.**

An interactive game where an AI Game Master gives you a realistic Kenyan
real-world mission — *start a small food business in Nairobi with KSh 8,000* —
and you have to solve it with decisions. Along the way the system is held to a
rule most chatbots do not keep:

> **It never tells you a Kenyan government requirement, fee, deadline or
> process it cannot point to a source for. When it does not know, it says it
> does not know — and shows you the hole.**

This is both a game and a demonstration of agentic AI, retrieval-grounded
generation, and AI evaluation. It is deliberately not a chatbot with a Kenyan
skin on it.

```bash
git clone https://github.com/anodesmith/bureaucracy-boss-fight.git
cd bureaucracy-boss-fight
npm install
npm start
# open http://localhost:3000
```

No API key. No network. No `ollama pull`. It works immediately.

---

## Contents

- [Why this is different from a chatbot](#why-this-is-different-from-a-chatbot)
- [The mission](#the-mission)
- [The thing this project is actually about](#the-thing-this-project-is-actually-about)
- [Gameplay](#gameplay)
- [The three agents](#the-three-agents)
- [The grounding model](#the-grounding-model)
- [AI evaluation](#ai-evaluation)
- [Model support](#model-support)
- [Running it](#running-it)
- [How to add new evidence](#how-to-add-new-evidence)
- [How to add new missions](#how-to-add-new-missions)
- [Project layout](#project-layout)
- [Limitations](#limitations)

---

## Why this is different from a chatbot

A chatbot has a conversation. This has a **simulation**.

| | Chatbot | This |
| --- | --- | --- |
| **State** | Forgets, or summarises | Persistent, typed, validated state |
| **Actions** | You type, it replies | Your input is *parsed into an intent* and resolved against rules |
| **Consequences** | It says something sad | Money, days, inventory and objectives actually change |
| **Evidence** | Confident prose | Every real-world sentence carries a label and a citation you can open |
| **Agents** | One model, one persona | Game Master / Evidence Agent / Critic, with separate jobs and separate permissions |
| **Evaluation** | Vibes | 66 automated tests and an adversarial matrix with published numbers |
| **Replayability** | None | Same seed + same actions = bit-identical state, proven |

The structural difference: **a language model here is a text function.** It has
no access to game state, no field it can assign money to, and no path to a
number the engine did not already compute. It writes prose and picks between
outcomes the engine has already calculated. The `GameMasterProposal` type has
three fields and none of them is a number.

That is not a prompt. It is a type signature. The evaluation proves it matters:
four deliberately broken Game Masters were run against the engine, and the
resulting game state was **byte-identical** to a clean run.

---

## The mission

> **Start a small food business in Nairobi with KSh 8,000.**
> Fourteen turns. Each one costs a day.

You are Achieng' Otieno, 29, with KSh 8,000 and no registered business. You can
cook. You do not know how to be a company.

Seven objectives, and the legal scaffolding is **real, quotable Kenyan law** from
the Registration of Business Names Act (Cap. 499):

- Lodge a name search at least **seven days** before you start trading (s.17(2))
- The Registrar must answer within **seven days** of receiving the fee
- Register within **twenty-eight days** of starting to trade (s.8(1))
- **Hang the certificate** where customers can see it — skipping it is an
  offence (s.14(4), 14(6))
- Discover that trading under your own surname alone may not trigger
  registration at all (s.4(b)) — and that this is a legitimate, different way
  to fail

Eight thousand shillings does not cover a trolley, a stove, stock, and the
registration fee. You have to choose. That is the game.

---

## The thing this project is actually about

**Nobody knows what registering a Kenyan business costs.**

Not the model. Not the developers. Not this repository.

The law authorises the charge and delegates the amount:

> *Business Registration Service Act*, s.4(2)(f):
> "charge fees for any service performed by the Service"
>
> *Registration of Business Names Act*, s.22(a): the Cabinet Secretary may make
> rules "prescribing (a) the fees to be paid to the Registrar"

The Act states no figure. So we went and looked at what the open web says:

| Source | Figure |
| --- | --- |
| A blog | KSh 950 (150 search + 800 registration) |
| A registration agent | KSh 950 combined; KSh 250 for an official search |
| A consultancy | KSh 850 |
| A media site | KSh 150 per name search |
| Another | KSh 1,000 for a sole proprietor |
| A portal | "confirm the current figure on eCitizen" |

Six sources. A factor of seven between them. None cites a gazette.

The honest engineering response is not to pick one. It is to **represent the
disagreement as the answer**, and make the player's inability to know the real
figure a load-bearing part of the game. So the knowledge base has a document
dedicated to the conflict, marked `CONFLICTED`, whose claims the loader
mechanically refuses to promote to `VERIFIED`.

There is a test asserting that no `VERIFIED` claim in this repository states a
monetary fee amount. It is the most important test in the suite.

---

## Gameplay

```
┌─ MISSION ──────────┬─ CONVERSATION ─────────────┬─ EVIDENCE ─────────┐
│ KSh 3,000          │ ▸ buy a trolley for        │ VERIFIED  (27)     │
│ Turn 6/14          │   KSh 5,000               │ C-RBN-08  s.17(1)   │
│ Day 7              │                           │ "The Registrar      │
│                    │ [VERIFIED] Section 17(2):  │  shall refuse..."   │
│ ▸ Find the rules ✓ │  the Registrar shall...   │ ─────────────────   │
│ ▸ Establish cost ✓ │  cites: C-RBN-06          │ UNKNOWN   (3)      │
│ ▸ Lodge search  ✓  │                           │ C-RBN-17           │
│ ▸ Register       ▸ │ [UNKNOWN] The amount of   │ "The amount is not  │
│ ▸ Display cert   ▸ │  the fee is not stated.   │  stated in the Act" │
│ ▸ Serve customer ▸ │  cites: C-RBN-17          │ ─────────────────   │
│ ▸ Stay solvent   ▸ │                           │ SOURCES  (5)       │
│                    │ [SIMULATION] The counter   │ kenyalaw.org →      │
│ INVENTORY          │  quotes KSh 1,000. A      │ kbrs.pesaflow.com → │
│ Trolley         ×1 │  figure invented for      │ eCitizen →         │
│ Stock           ×1 │  this game.               │                     │
│                    │                           │ [Lab] [Evidence]   │
│ EVIDENCE           │ ▸ _______________________  │ [Sources]          │
│ 27 verified        │ [Research][Ask][Buy][...] │                    │
└────────────────────┴───────────────────────────┴────────────────────┘
```

**Actions** — Research, Ask, Buy, Contact, Apply, Travel, Inspect, Wait, or
just type it. The parser handles free text and tells you when it is unsure
rather than guessing:

> "I spend KSh 5,000 buying a trolley." → `BUY { item: "trolley", amount: 5000 }`

**Hidden information** — the real fee is never revealed by the opening. You have
to go and look, and what you find is that nobody knows.

**The counter quotes a fee anyway.** When you go in person, a fictional clerk
quotes a number. It is labelled `[SIMULATION]` and the narration says plainly
that the figure was invented for the game. The game needs a number for you to
budget against. It just refuses to pretend the number is real.

**Endings are graded at the end**, from S to D, including
*Under Your Own Name* for players who read section 4(b) and correctly decide
registration never triggers.

---

## The three agents

### GAME MASTER
Runs the world. Picks which of the engine's pre-computed options happens, and
writes the prose.

Its entire consequential output is `chosenOptionId`. It cannot set a price,
invent a requirement, or change your balance — not because it is asked not to,
but because `GameMasterProposal` has no field for any of those.

### EVIDENCE AGENT
Retrieves claims from `knowledge/`, decides which are citable, and reports
gaps.

It cannot invent a requirement because **every citation it can produce already
exists as a labelled claim in a file.** It can rank claims, filter claims, and
report holes. It cannot write new ones. `isUsable` is a single predicate
enforced by the loader, the retriever, the citation validator, the narration
classifier and the gap detector, so the rule cannot be applied in one place and
forgotten in another.

A retrieval is also judged on *answerability*, not just topical relevance.
Asking "how much is the prescribed fee" retrieves plenty of citable material —
the Act says a fee is payable and says the amount lives in rules. Every one of
those claims is `VERIFIED`, and none answers the question. Without a separate
check, the player would get a confident, well-cited, completely unanswering
reply. That is a more insidious failure than an obvious gap, so it gets its own
detection.

### CRITIC / JUDGE
Audits the finished turn and emits structured evaluation data.

**It is deterministic code, not a model.** Deliberately: a judge that is itself
a language model cannot reliably detect hallucination, because its failure mode
is the thing it is measuring. It would also be non-deterministic, making
evaluation noisy and replay impossible, and its scores would not be comparable
across providers.

Ten checks, including `citation-missing`, `launder`, `contradictions`,
`fiction-as-fact`, `state-transition` and `option-selection`. A failure caps the
score below the pass threshold, so a failed turn can never display a number
that reads like a pass.

---

## The grounding model

Every real-world sentence carries exactly one label, and the label is the point.

| Label | Means | Requires |
| --- | --- | --- |
| **VERIFIED** | directly supported by a quoted source | a quote, a locator, a verified document |
| **INFERRED** | a conclusion drawn from sources | its derivation |
| **UNKNOWN** | the record does not answer this | a recorded reason why not |
| **SIMULATION** | invented for the game | nothing — but must not read as fact |

The source material is genuine primary law, quoted verbatim from
[kenyalaw.org](https://kenyalaw.org/akn/ke/act/1951/48/eng@2022-12-31), with
retrieval dates and document verification state recorded per document.

**UNKNOWNS ARE FIRST-CLASS.** They are the answer, not a failure. Click any
citation in the UI to open the claim and read the actual quote from the actual
source. If a claim is `UNKNOWN`, the UI says why it is unknown.

**A conflicted document cannot be cited as fact.** The loader downgrades every
`VERIFIED` claim inside a `CONFLICTED` document to `UNKNOWN` and reports it.

---

## AI evaluation

```bash
npm run eval              # human-readable report
npm run eval -- --json    # machine-readable
npm test                  # 66 tests
npm run kb:check          # knowledge base integrity
```

Published results, demo mode, 5 episodes × 4 seeds = 280 turns:

```
  episode          turns  critic   pass%  unsup  invent  contra
  the-grinder         56     100    100%      0       0       0
  the-gambler         56     100    100%      0       0       0
  the-hoarder         56     100    100%      0       0       0
  own-name            56     100    100%      0       0       0
  the-confused        56     100    100%      0       0       0

  Grounding labels used:
    FICTIONAL_GAME_EVENT      588  ##################......
    VERIFIED                  161  #####...................
    UNKNOWN                    44  #.......................

  replay hash == live hash         20/20
  repeat run == first run          20/20
```

**The adversarial matrix** is the part that matters:

```
  adversary             detected  state==clean    damage
  fabricator               14/14           yes      none
  launderer                14/14           yes      none
  masquerader               5/14           yes      none
  tamperer                 14/14           yes      none
```

Four broken Game Masters, each trying a different way to take over the game.
`detected` shows the Critic caught them. **`state==clean: yes` is the real
result** — their narration was wrong and the simulation was bit-for-bit
identical anyway.

A healthy grounding mix is mostly `SIMULATION`, a meaningful minority of
`VERIFIED`, and a **non-zero number of `UNKNOWN`**. A run with zero unknowns is
a warning sign, not an achievement: it would mean the system had stopped
admitting what it does not know.

Full detail in [`docs/evaluation.md`](docs/evaluation.md).

---

## Model support

The AI layer sits behind a one-method interface. A new backend is one small
file and cannot change how the agents reason.

```ts
interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  healthCheck(): Promise<HealthReport>;
}
```

| Mode | `PROVIDER=` | Needs |
| --- | --- | --- |
| **Demo** *(default)* | `demo` | nothing. Deterministic, fully playable |
| **OpenAI-compatible** | `openai` | `API_KEY`, `BASE_URL`, `MODEL` |
| **Ollama** | `ollama` | a running Ollama with the model pulled |

```bash
# OpenAI
PROVIDER=openai API_KEY=sk-... MODEL=gpt-4o-mini npm start

# OpenRouter
PROVIDER=openai \
API_KEY=sk-or-... \
BASE_URL=https://openrouter.ai/api/v1 \
MODEL=anthropic/claude-sonnet-4 npm start

# Local, fully offline
PROVIDER=ollama OLLAMA_MODEL=llama3.1 npm start

# Any local OpenAI-compatible server
PROVIDER=openai BASE_URL=http://localhost:1234/v1 MODEL=<model> npm start
```

`API_KEY` is optional for local servers, and the provider is skipped with a
visible reason rather than failing silently.

**Demo mode is not a stub.** It is a complete Game Master that reads the
evidence bundle, answers from verified claims, and reports gaps. It is also the
**control condition** for evaluation: same seeds, same engine, same evidence,
so you can measure what the model actually contributed.

Full reasoning in [`docs/architecture.md`](docs/architecture.md).

---

## Running it

Requirements: **Node 20.11+** (developed on 24). Nothing else.

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # watch mode
npm test             # 66 tests
npm run typecheck
npm run kb:check     # knowledge base integrity
npm run eval         # evaluation report
npx tsx src/scripts/smoke.ts   # play a scripted run in the terminal
```

Set a seed in the UI to replay a run exactly. The same seed and the same
actions always produce the same result — that is a tested property, not an
aspiration.

---

## How to add new evidence

Drop a Markdown file in `knowledge/`. Format documented in
[`knowledge/README.md`](knowledge/README.md).

```markdown
---
id: ke-my-source
title: ...
source: ...
source_url: https://...
document_type: primary_legislation
jurisdiction: Kenya (national)
version_date: 2026-01-01
retrieved_at: 2026-09-29
verification: VERIFIED
---

### C-MINE-01 VERIFIED
- **claim**: ...
- **locator**: section 12
- **quote**: "verbatim"
- **topics**: ...
```

Rules the loader enforces, and `npm run kb:check` will fail you on:

- `VERIFIED` claims need a quote and a real locator
- claims in a `CONFLICTED` document **cannot** be `VERIFIED`
- `UNKNOWN` claims must record why they are unknown
- `INFERRED` claims must record their derivation

Then run `npm run kb:check && npm test`.

If your new document makes the fee knowable, the mission's central puzzle
dissolves. That is a good outcome and a slightly worse demo.

---

## How to add new missions

See [`docs/adding-missions.md`](docs/adding-missions.md). A mission is data
plus a set of ordered rules. It needs to know nothing about language models.

```ts
const rBuy: Rule = {
  id: 'r-buy',
  purpose: 'One line, shown in Lab Mode.',
  when: (ctx) => ctx.intent.type === 'BUY',
  resolve: (ctx) => [ option('buy', 'Buy a trolley', effects, narration) ],
};
```

Three rules that will save you time:

- **Prices come from the scenario, never the model.** Put them in a constant and
  label them `[SIMULATION]`.
- **Affordability is checked for you.** `gateOnFunds` marks unaffordable
  options unavailable automatically.
- **A no-op still costs a day.** Otherwise players stall for free and the
  deadline stops meaning anything.

---

## Project layout

```
src/
  core/           types, deterministic RNG, stable hashing
  game/
    state/        the only code that mutates state
    actions/      free-text → intent parser
    scenarios/    the rules of each mission
    engine.ts     the turn pipeline
  agents/
    evidence/     knowledge loader, BM25 retriever, gap detection
    game_master/  demo (deterministic) and LLM-backed
    critic/       the ten audit checks
  providers/      Ollama, OpenAI-compatible, config
  server/         HTTP API
  eval/           evaluation harness, CLI, knowledge checker
knowledge/        five source documents, 48 labelled claims
public/           the UI, no build step
tests/            66 tests
docs/             architecture, evaluation, missions, limitations
```

Two runtime dependencies: `express`. Everything else is dev tooling.

---

## Limitations

The full list is in [`docs/limitations.md`](docs/limitations.md). The ones that
matter most:

- **The fee is unknown and this project does not guess it.** A test enforces it.
- **Five source documents.** County permits, food handling, KRA: all UNKNOWN.
  Absence of a source is not evidence that no requirement exists.
- **The BRS Act snapshot is one amendment behind** the current published
  version. Recorded in the document.
- **All simulation prices are invented** and labelled as such. The simulated
  fee is chosen to look plausible, precisely so nobody mistakes the game for a
  quotation.
- **One mission.** The framework should generalise. That is an untested guess.
- **A passing Critic score is not a proof of truth.** It is evidence that
  specific, enumerated failure modes did not occur on that turn.
- **The Critic is high-precision, not high-recall.** It will not catch a
  subtly misleading sentence that cites a real claim and reads plausibly.
- **Lab Mode is not chain-of-thought and will not become chain-of-thought.**
  You can check every decision. You cannot see why a particular word was
  chosen. That trade is deliberate and argued in `docs/architecture.md`.
- **Not legal advice.**

---

## Licence

MIT.

Source documents are quoted from their publishers. Kenya Law states its
contents are in the public domain except material under a specified Creative
Commons licence; per-document provenance and copyright notes are in the
document frontmatter.

If you close the fee gap and this stops being a good demo, that is still a good
outcome.
