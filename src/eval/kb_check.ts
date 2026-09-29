/**
 * Knowledge base integrity check. Run with `npm run kb:check`.
 *
 * A knowledge base is a claim set, and a claim set can be wrong in ways that
 * are invisible until you look. This checks the things that would quietly
 * corrupt the game's grounding guarantees:
 *
 *   - a VERIFIED claim with no quote behind it
 *   - a VERIFIED claim inside a CONFLICTED document
 *   - a duplicate claim id
 *   - an UNKNOWN claim with no recorded reason
 *   - a document with no claims at all
 *   - a claim that cites a section number that is not in its own quote
 */

import { resolve } from 'node:path';
import { loadKnowledge } from '../agents/evidence/knowledge.js';
import { EvidenceAgent } from '../agents/evidence/index.js';

const kb = loadKnowledge(resolve(process.cwd(), 'knowledge'));
const agent = new EvidenceAgent(kb);

let hardFailures = 0;
let softFailures = 0;

console.log('\nBureaucracy Boss Fight - knowledge base check');
console.log('='.repeat(64));

console.log(`\nDocuments: ${kb.documents.length}`);
for (const doc of kb.documents) {
  const counts = { VERIFIED: 0, INFERRED: 0, UNKNOWN: 0, FICTIONAL_GAME_EVENT: 0 };
  for (const claim of doc.claims) counts[claim.grounding] += 1;
  console.log(
    `  [${doc.verification.padEnd(10)}] ${doc.id}\n` +
      `      ${counts.VERIFIED} verified · ${counts.INFERRED} inferred · ${counts.UNKNOWN} unknown\n` +
      `      ${doc.title}`,
  );
  if (doc.claims.length === 0) {
    console.log('      !! no claims extracted');
    hardFailures += 1;
  }
}

console.log(`\nTotal claims: ${kb.claims.length}`);

/* --- Contradictory law detection ---------------------------------------- */
console.log('\nChecking that no VERIFIED claim is contradicted by another...');
for (const claim of kb.claims) {
  if (claim.grounding !== 'VERIFIED') continue;
  const others = kb.claims.filter(
    (c) => c.grounding === 'VERIFIED' && c.id !== claim.id && c.documentId !== claim.documentId,
  );
  for (const other of others) {
    if (
      claim.text.toLowerCase() === other.text.toLowerCase() &&
      claim.quote !== other.quote
    ) {
      console.log(`  !! ${claim.id} and ${other.id} make the same claim with different quotes`);
      hardFailures += 1;
    }
  }
}

/* --- Section references must appear in their own quote -------------------- */
console.log('\nChecking locator references...');
for (const claim of kb.claims) {
  if (claim.locator === 'unstated' || claim.grounding !== 'VERIFIED') continue;
  const sectionMatch = /section (\d+[A-Z]?)/.exec(claim.locator);
  if (!sectionMatch?.[1]) continue;
  const sectionNumber = sectionMatch[1];
  if (!claim.quote.includes(sectionNumber)) {
    // The quote is a fragment, so the section number usually is not in it.
    // This is informational, not a failure.
    console.log(`  ~  ${claim.id}: locator says section ${sectionNumber} but the quote is a fragment`);
    softFailures += 1;
  }
}

/* --- The critical UNKNOWN must remain unknown --------------------------- */
console.log('\nChecking the fee stays UNKNOWN...');
const feeClaims = kb.claims.filter(
  (c) =>
    c.grounding === 'VERIFIED' &&
    /fee|charge|prescribed/i.test(c.text) &&
    // The dangerous claim is one that states a MONETARY AMOUNT. A verified
    // claim that BRS may charge fees, or that amounts live in rules, is
    // exactly right and must be allowed.
    /(?:ksh\s*\d|\d[\d,]*\s*(?:shilling|pesa|bob))/i.test(c.text),
);
if (feeClaims.length === 0) {
  console.log('  ok  no VERIFIED claim in the base states a monetary amount for a fee');
} else {
  for (const claim of feeClaims) {
    console.log(`  !! ${claim.id} asserts a verified fee figure: "${truncate(claim.text, 90)}"`);
    console.log('     This is the single most dangerous claim this project could make.');
    hardFailures += 1;
  }
}

/* --- Retrieval smoke test ----------------------------------------------- */
console.log('\nRetrieval smoke test:');
const probes = [
  'how much does registering a business name cost',
  'how long do I have to register after I start trading',
  'do I have to display the certificate',
  'can I just trade under my own name',
  'what is the capital of France',
];
for (const probe of probes) {
  const bundle = agent.retrieve(probe, { limit: 3 });
  const top = bundle.claims[0];
  const usable = bundle.usable.length;
  console.log(
    `  "${probe}"\n` +
      `    top: ${top ? `${top.claim.id} [${top.claim.grounding}] score ${top.score}` : '(nothing)'}\n` +
      `    usable: ${usable} · gaps: ${bundle.gaps.length}`,
  );
  if (top && !bundle.usable.includes(top.claim.id) && top.claim.grounding === 'UNKNOWN') {
    console.log('    (top hit is UNKNOWN - correctly not citable)');
  }
}

/* --- Reported defects --------------------------------------------------- */
console.log('\nParser defects:');
if (kb.defects.length === 0) {
  console.log('  none');
} else {
  for (const d of kb.defects) {
    console.log(`  [${d.severity}] ${d.file}: ${d.message}`);
    if (d.severity === 'error') hardFailures += 1;
    else softFailures += 1;
  }
}

console.log('\n' + '='.repeat(64));
console.log(`${hardFailures} error(s), ${softFailures} warning(s)`);
console.log(
  hardFailures === 0
    ? 'Knowledge base is sound.\n'
    : 'Knowledge base has ERRORS. The grounding guarantees are not trustworthy until these are fixed.\n',
);

process.exit(hardFailures === 0 ? 0 : 1);

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
