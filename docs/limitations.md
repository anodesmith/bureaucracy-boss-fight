# Limitations

An honest list. The claims this project makes are narrow, and so are the things
it cannot do.

## About the real world

**The registration fee is unknown, and this project does not guess it.**
Section 4(2)(f) of the Business Registration Service Act authorises the BRS to
"charge fees for any service performed by the Service" but states no amount.
Section 22(a) of the Registration of Business Names Act shows why: the amount is
prescribed by rules made by the Cabinet Secretary, and those rules are not in
this knowledge base. A test asserts that no `VERIFIED` claim here states a
monetary fee amount.

If you close that gap — by finding the gazetted fee schedule — you should add it
as a primary document and the game's central puzzle dissolves. That would be a
better knowledge base and a slightly worse demo.

**The knowledge base is five documents.** It covers business *name*
registration well (the Registration of Business Names Act, Cap. 499, is
thoroughly mined) and almost nothing else. County permits, food handling
licences, KRA PINs, NHIF, market stall allocation, fire inspection: all
UNKNOWN. Absence of a source is not evidence that no requirement exists, and
the game does not treat it as such.

**The BRS Act snapshot is one amendment behind.** The entry records a version
dated 27 December 2024 and notes that Kenya Law showed a 25 September 2026
version at retrieval time. Re-run `npm run kb:check` and refresh before relying
on any of it in a real advisory context.

**Nothing here is legal advice.** The game is a simulation built on public
primary law. Kenyan practice differs from the statutory text in ways this
knowledge base cannot capture, and the BRS Act entry records one such open
question: whether online filing on the BRS or eCitizen portal discharges the
statutory requirement to "send by registered post or deliver" to the Registrar.
Nobody in this repository knows the answer.

**The simulation's numbers are invented.** KSh 5,000 for a trolley, KSh 1,000
for the fee the counter quotes, KSh 150 a day to trade: these are game
parameters chosen to make the arithmetic interesting. They are labelled
`[SIMULATION]` in the narration the player sees. They are **not** claims about
Kenya, and the simulated fee is chosen to look plausible precisely so that a
player does not mistake the game for a quotation.

## About the system

**One mission.** One vertical slice, done properly. The scenario framework
generalises and `docs/adding-missions.md` documents it, but a second mission
has not been written, so the abstraction is unproven. Treat it as a reasonable
guess rather than a tested fact.

**The Game Master's contribution is narrow and that is by design.** It writes
prose and picks between pre-computed options. Swapping in a much stronger model
should improve the writing and change the state hash not at all. If a stronger
model *does* change the state hash, that is a bug in the guard rails, and
`npm test` should catch it.

**Retrieval is BM25 and it always returns its best guess.** Asking about
something unrelated still returns the least irrelevant claim. Two mechanisms
compensate: single-term coincidences are demoted out of `usable` and reported
as a gap, and `validateCitation` rejects assertions the cited claim does not
overlap with. But the guarantee is enforced *downstream of retrieval*. A
different retriever — embeddings, a reranker — would need those downstream
checks to stay exactly where they are.

**The Critic is high-precision, not high-recall.** It is deliberately narrow:
it catches fabricated ids, unsupported citations, laundered unknowns,
contradicted quantities and fiction masquerading as fact. It will not catch a
subtly misleading sentence that cites a real claim and reads plausibly. The
adversarial evaluation measures the classes it is built to catch, not the
space of all possible untruths. **A passing Critic score is not a proof of
truth.** It is evidence that specific, enumerated failure modes did not occur
on that turn.

**Contradiction detection compares quantities only.** Money and durations. A
claim cited for a statement that reverses its direction ("you are not required
to...") would pass. Narrow by design: comparing every integer in a sentence
made `C-FEE-04` and "section 8(1)" look like contradicted figures, and an
instrument that cries wolf is worse than no instrument.

**Lab Mode is not chain-of-thought and will not become chain-of-thought.** See
`docs/architecture.md` for why. The consequence is real: you can see what the
system decided and check it, but you cannot see why a particular word was
chosen. That trade is deliberate.

**The state is in memory.** Refreshing the page loses your run. There is no
account, no database, no persistence. A run can be replayed exactly from its
seed and action list, which is the durable form that actually matters for a
project about determinism, but a transcript cannot yet be exported as a file
from the UI.

**One language, one jurisdiction, one era.** All narration is in English. The
game assumes the player is comfortable reading statute. Both assumptions are
load-bearing and untested outside this audience.

## What would strengthen it

In rough priority order:

1. **The gazetted fee schedule.** Close the central UNKNOWN. It is the single
   most valuable missing document.
2. **A second mission**, written without looking at the first, as a real test
   of the scenario framework.
3. **Nairobi County primary sources.** Permits and public health are where a
   real food business actually gets stuck, and they are entirely absent.
4. **Adversarial evaluation against a live model.** The evaluation harness
   supports it (`npm run eval -- --matrix`), but the published numbers are all
   from demo mode and from the built-in adversaries.
5. **Player-facing replay export.** Seed plus actions is already enough; it
   just needs a download button.
6. **A regression corpus** of real questions people ask, as tests. The current
   probes were written by the same person who wrote the knowledge base, which
   is a conflict of interest worth naming.
