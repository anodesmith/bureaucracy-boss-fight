# Architecture

## The one idea

A language model is a **text function** in this system. It reads a prompt and
returns text. It has no access to game state, no ability to write a file, no
tool to call, and no path to any number the engine did not already compute.

Everything interesting follows from taking that seriously.

## Layers

```
browser  ──HTTP──►  server  ──►  engine  ──►  state
                                      ▲
                          ┌───────────┴───────────┐
                          │                       │
                    scenario rules          game master (model)
                          │                       │
                          │                   evidence agent
                          │                       │
                          └──────────► critic ◄──┘
```

| Layer | Knows about | Can change |
| --- | --- | --- |
| `game/state.ts` | the rules of validity | the state, and nothing else |
| `game/scenarios/*` | the fiction and its rules | which effects are legal |
| `game/engine.ts` | the turn pipeline | nothing directly |
| `agents/evidence` | `knowledge/` | nothing |
| `agents/game_master` | a turn context | which legal option is chosen |
| `agents/critic` | a finished turn | nothing |

## The turn pipeline

`engine.submitAction` runs these steps in order. The order is the design.

1. **Parse.** A transparent rule-based parser turns free text into an
   `ActionIntent`. Deterministic, because the action sequence is half of the
   replay key.
2. **Validate shape.** A malformed action is rejected *before* anything else
   and costs no turn.
3. **Retrieve.** The Evidence Agent runs BM25 over the knowledge base for
   several angles on the action, and returns claims, which are citable, and
   gaps, which are not.
4. **Resolve.** The scenario's rules compute every outcome that is legal this
   turn. Each is an `EffectOption` carrying its effects, its narration, and the
   `ruleId` that produced it. This is pure code. No model is involved.
5. **Propose.** The Game Master picks one of those options and writes prose.
6. **Apply.** `applyEffects` validates every effect against an invariant before
   applying it. An effect that would break one is refused and reported, never
   partially applied.
7. **Audit.** The engine checks the statutory clock, unlocks objectives the
   player has now earned, and decides whether the run is over.
8. **Critique.** The Critic audits the turn and emits structured data.

## Why the model cannot invent a fee

Three independent mechanisms, in increasing order of severity:

**1. It is never asked.** The Game Master's job is `chosenOptionId` plus prose.
The prompt has no field for a price.

**2. It has nowhere to put one.** `GameMasterProposal` has no money field, no
inventory field, no flag field. There is no key to assign.

**3. Its choice is validated anyway.** Even a fabricated `chosenOptionId` is
discarded: the engine intersects the proposal with the options it computed and
falls back to a real one. And the final `Critic` records the attempt.

Money only moves through `MONEY_DELTA` effects, and those only exist inside
`EffectOption`s that scenario code built.

## Why the Critic is not a model

The Critic is deterministic code, on purpose.

- A judge that is itself a language model cannot reliably detect hallucination,
  because its failure mode is the thing it is measuring.
- A model Critic would be non-deterministic, making evaluation scores noisy and
  replay impossible.
- Every check must be comparable across providers, which requires code.

Its checks are in `agents/critic/index.ts`. The load-bearing ones:

| Check | Severity | Catches |
| --- | --- | --- |
| `citation-missing-<id>` | blocking | invented claim ids |
| `citation-<id>` | blocking | citing a real claim for a different assertion |
| `bare-verified-<n>` | blocking | `VERIFIED` with no citation |
| `launder-<id>` | blocking | an `UNKNOWN` claim used to support a known one |
| `contradictions` | blocking | asserting numbers the source does not contain |
| `fiction-as-fact-<n>` | major | a real requirement dressed as a game event |
| `assertive-unknown-<n>` | major | giving an answer while claiming ignorance |
| `state-transition` | blocking | money that does not reconcile with the effects |
| `option-selection` | blocking | selecting an option the engine never offered |
| `invariants` | blocking | any broken state invariant |

A failure caps the score below the pass threshold, so a failed turn can never
display a number that reads like a pass.

## Determinism

`seed` + action sequence fully determines the simulation.

- The PRNG is SplitMix32 with its cursor serialised into `GameState`, so
  replay resumes exactly.
- The parser is rule-based.
- The scenario is pure code.
- The only nondeterminism the system *tolerates* is the Game Master's prose,
  which cannot reach the state.

`stateHash` is an FNV-1a hash of a canonical digest. Tests assert that live
play and replay agree, that two replays agree, and that adversarial Game
Masters leave the hash unchanged.

## The four grounding categories

| Category | Requires | Enforced by |
| --- | --- | --- |
| `VERIFIED` | a quote, a locator, a `VERIFIED` document | loader, `EvidenceAgent.isUsable` |
| `INFERRED` | a derivation | loader, `EvidenceAgent.isUsable` |
| `UNKNOWN` | a recorded reason | loader, `EvidenceAgent.isUsable` |
| `FICTIONAL_GAME_EVENT` | nothing, but must not read as fact | `looksLikeInventedRequirement` |

`isUsable` is the single predicate. It is called by the retriever, by the
citation validator, by the narration classifier, and by the gap detector, so
the rule cannot be enforced in one place and forgotten in another.

## Why no chain of thought

Lab Mode shows retrieved evidence, the grounding label, the options the engine
computed, the chosen option, the state transition, and the Critic's structured
verdict.

It does not show the model's reasoning, and the prompt does not ask for it.

Three reasons. First, a rationale generated by the same model that generated
the claim is not evidence about the claim. Second, asking for reasoning makes
models more likely to confabulate a justification, and a confident
justification is harder to audit than a bare claim. Third, the checks here are
all decidable by code, so there is nothing a rationale would add.

`decision_summary` is requested instead: a one-sentence description of the
choice, not a chain of inference.

## Why lexical retrieval

BM25 over claim text, topics and quotes. No embeddings, no vector store, no
network.

- It runs offline, so the demo is genuinely zero-dependency.
- It is inspectable, which is what Lab Mode needs.
- A better retriever could only ever find *more of the same verified claims*.
  There is no accuracy argument for opacity when the failure mode that matters
  is "the model cited something not in the source", and that is prevented at
  the citation layer, not the retrieval layer.

The known weakness is precision on off-topic queries, and it is real: BM25
always returns its best guess. `EvidenceAgent.isRelevant` demotes
single-term coincidences out of `usable` and reports them as a gap, and
`validateCitation` rejects assertions the claim does not overlap with. The
guarantee is enforced downstream of retrieval, not by retrieval itself.
