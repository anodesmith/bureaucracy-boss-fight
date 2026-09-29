# Knowledge base

This directory is the **only** place a statement about the real world may come
from. If it is not here, the system cannot say it.

Each file is one document plus a set of explicitly labelled claims. Only the
claims can ever be cited. The prose summary is for humans.

## File format

```markdown
---
id: ke-some-document                 # kebab-case, unique
title: Human readable title
source: Who published it
source_url: https://...
document_type: primary_legislation   # see below
jurisdiction: Kenya (national)
version_date: 2024-12-27             # the version of the source itself
retrieved_at: 2026-09-29             # when you fetched it
retrieval_method: HTTP GET of ...
verification: VERIFIED                # VERIFIED | CONFLICTED | UNVERIFIED
verification_note: >
  How you know this is what it claims to be, and what would make it stale.
---

## Summary

Prose, for humans. Never cited.

### C-PREFIX-01 VERIFIED
- **claim**: The claim, restated in plain language.
- **locator**: section 8(1)
- **quote**: "verbatim text from the source"
- **topics**: comma, separated, lower-case

### C-PREFIX-02 UNKNOWN
- **claim**: The thing you wish you knew.
- **locator**: not present in this document
- **quote**: ""
- **unknown_reason**: Why the system does not know. Required.
- **topics**: ...
```

`document_type` must be one of: `primary_legislation`, `government_portal`,
`secondary_aggregated`, `official_notice`, `news`, `commentary`.

`verification` must be one of:

| Value | Meaning | Effect |
| --- | --- | --- |
| `VERIFIED` | You fetched it and it says what it claims | Claims may be `VERIFIED` |
| `CONFLICTED` | Sources disagree, or this document records a disagreement | **Claims are auto-downgraded to `UNKNOWN`** |
| `UNVERIFIED` | Referenced but not checked | Claims may not be `VERIFIED` |

## Rules the loader enforces

`npm run kb:check` runs these as hard errors:

- A `VERIFIED` claim must have a non-empty `quote`.
- A `VERIFIED` claim must have a real `locator` (not `unstated`).
- A claim in a `CONFLICTED` document **cannot** be `VERIFIED`. It is silently
  downgraded and reported.
- Claim ids must be globally unique and match `C-PREFIX-01`.
- An `UNKNOWN` claim must record why it is unknown.
- An `INFERRED` claim must record its derivation.

## Rules you should enforce yourself

- **Never write a fee amount as a `VERIFIED` claim.** A test asserts that no
  `VERIFIED` claim in this repository states a monetary amount for a fee. If you
  find the actual gazetted figure, add it as a new document — the real fee
  schedule — and cite that.
- Quote verbatim. Paraphrase in `claim`, not in `quote`.
- Record `retrieved_at`. Law changes.
- If a document is a snapshot, say so in `verification_note`. The BRS Act entry
  notes that it is one amendment behind.

## Adding a document

1. Fetch the source. Prefer the primary publisher: `kenyalaw.org` for
   legislation, the agency's own site for portals.
2. Copy the relevant text **verbatim** into `quote` fields.
3. Set `retrieved_at` to today and `version_date` to the source's own date.
4. Record the retrieval method. If you did not fetch it, say so and mark it
   `UNVERIFIED`.
5. Run `npm run kb:check`.
6. Run `npm test`.

## Current contents

| Document | Type | Verification | Claims |
| --- | --- | --- | --- |
| `ke-registration-of-business-names-act-1951.md` | primary_legislation | VERIFIED | 18 |
| `ke-brs-act-2015.md` | primary_legislation | VERIFIED | 10 |
| `ke-brs-portal.md` | government_portal | VERIFIED | 6 |
| `ke-ecitizen-portal.md` | government_portal | VERIFIED | 4 |
| `ke-fee-figures-conflict.md` | secondary_aggregated | CONFLICTED | 10 |

The conflict document is deliberate and load-bearing. It records that the open
web disagrees with itself about the registration fee by a factor of seven, and
it is why the mission's central question has no answer.
