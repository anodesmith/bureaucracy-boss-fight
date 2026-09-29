/**
 * Knowledge base loader.
 *
 * Reads `knowledge/*.md`. Each file is a document with YAML-ish frontmatter and
 * a set of explicitly labelled claims.
 *
 * The claim blocks are the important part. A document's prose summary is for
 * humans; only the labelled claims may ever be cited by an agent. That is the
 * mechanical reason the system cannot invent an official requirement: there is
 * no code path from prose to a citation.
 *
 * Document format is documented in `knowledge/README.md`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DocumentType,
  DocumentVerification,
  EvidenceClaim,
  EvidenceDocument,
  Grounding,
} from '../../core/types.js';

const GROUNDINGS: Grounding[] = ['VERIFIED', 'INFERRED', 'UNKNOWN', 'FICTIONAL_GAME_EVENT'];
const DOC_VERIFICATIONS: DocumentVerification[] = ['VERIFIED', 'CONFLICTED', 'UNVERIFIED'];
const DOC_TYPES: DocumentType[] = [
  'primary_legislation',
  'government_portal',
  'secondary_aggregated',
  'official_notice',
  'news',
  'commentary',
];

/** A structural problem in the knowledge base. Surfaced by `npm run kb:check`. */
export interface KnowledgeDefect {
  file: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface KnowledgeBase {
  documents: EvidenceDocument[];
  claims: EvidenceClaim[];
  defects: KnowledgeDefect[];
  byClaimId: Map<string, EvidenceClaim>;
  byDocumentId: Map<string, EvidenceDocument>;
  /** Which file each claim came from. Used for defect reporting. */
  fileByClaimId: Map<string, string>;
}

const CLAIM_HEADING = /^###\s+(C-[A-Z]+-\d+)\s+(VERIFIED|INFERRED|UNKNOWN|FICTIONAL_GAME_EVENT)\s*$/;

export function loadKnowledge(dir: string): KnowledgeBase {
  const defects: KnowledgeDefect[] = [];
  const documents: EvidenceDocument[] = [];
  const fileByDocumentId = new Map<string, string>();

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  } catch {
    throw new Error(`knowledge directory not found: ${dir}`);
  }

  for (const file of files.sort()) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const parsed = parseDocument(file, raw, defects);
    if (parsed) {
      documents.push(parsed);
      fileByDocumentId.set(parsed.id, file);
    }
  }

  const claims: EvidenceClaim[] = [];
  const claimFiles = new Map<string, string>();
  const byClaimId = new Map<string, EvidenceClaim>();
  const byDocumentId = new Map<string, EvidenceDocument>();

  for (const doc of documents) {
    byDocumentId.set(doc.id, doc);
    for (const claim of doc.claims) {
      const file = fileByDocumentId.get(doc.id) ?? doc.id;
      if (byClaimId.has(claim.id)) {
        defects.push({
          file,
          severity: 'error',
          message: `duplicate claim id ${claim.id} (also in ${
            byClaimId.get(claim.id)!.documentId
          })`,
        });
        continue;
      }
      // A CONFLICTED document may never assert VERIFIED. This is the rule that
      // stops web-blog figures from ever being promoted to fact.
      if (doc.verification === 'CONFLICTED' && claim.grounding === 'VERIFIED') {
        defects.push({
          file,
          severity: 'error',
          message: `claim ${claim.id} is marked VERIFIED but lives in a CONFLICTED document; downgrading to UNKNOWN`,
        });
        claim.grounding = 'UNKNOWN';
        claim.unknownReason =
          claim.unknownReason ||
          'Downgraded automatically: the containing document is marked CONFLICTED, so its claims cannot be VERIFIED.';
      }
      if (claim.grounding === 'VERIFIED' && claim.quote.trim() === '') {
        defects.push({
          file,
          severity: 'error',
          message: `claim ${claim.id} is VERIFIED but has no supporting quote`,
        });
      }
      if (claim.grounding === 'UNKNOWN' && claim.unknownReason.trim() === '') {
        defects.push({
          file,
          severity: 'warning',
          message: `claim ${claim.id} is UNKNOWN with no stated reason`,
        });
      }
      if (claim.grounding === 'INFERRED' && claim.derivation.trim() === '') {
        defects.push({
          file,
          severity: 'warning',
          message: `claim ${claim.id} is INFERRED with no derivation`,
        });
      }
      claims.push(claim);
      byClaimId.set(claim.id, claim);
      claimFiles.set(claim.id, file);
    }
  }

  return { documents, claims, defects, byClaimId, byDocumentId, fileByClaimId: claimFiles };
}

function parseDocument(
  file: string,
  raw: string,
  defects: KnowledgeDefect[],
): EvidenceDocument | null {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!frontmatterMatch?.[1]) {
    defects.push({ file, severity: 'error', message: 'missing YAML frontmatter block' });
    return null;
  }

  const meta = parseFrontmatter(frontmatterMatch[1]);
  const body = raw.slice(frontmatterMatch[0].length);

  const id = meta.id;
  if (!id) {
    defects.push({ file, severity: 'error', message: 'frontmatter is missing `id`' });
    return null;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    defects.push({ file, severity: 'warning', message: `document id "${id}" is not kebab-case` });
  }

  const verification = pick(meta.verification, DOC_VERIFICATIONS);
  if (verification === null) {
    defects.push({
      file,
      severity: 'error',
      message: `frontmatter \`verification\` must be one of ${DOC_VERIFICATIONS.join(', ')}`,
    });
    return null;
  }
  const documentType = pick(meta.documentType, DOC_TYPES);
  if (documentType === null) {
    defects.push({
      file,
      severity: 'error',
      message: `frontmatter \`document_type\` must be one of ${DOC_TYPES.join(', ')}`,
    });
    return null;
  }

  const summaryMatch = /^##\s+Summary\s*$([\s\S]*?)(?=^###\s|\Z)/m.exec(body);
  const summary = summaryMatch?.[1]
    ? summaryMatch[1]
        .split('\n')
        .filter((l) => l.trim() !== '')
        .join(' ')
        .trim()
    : '';

  const claims = parseClaims(body, file, meta, verification, defects);

  return {
    id,
    title: meta.title ?? id,
    source: meta.source ?? 'unstated',
    sourceUrl: meta.sourceUrl ?? '',
    documentType,
    jurisdiction: meta.jurisdiction ?? 'unstated',
    versionDate: meta.versionDate ?? 'unstated',
    retrievedAt: meta.retrievedAt ?? 'unstated',
    retrievalMethod: meta.retrievalMethod ?? 'unstated',
    verification,
    verificationNote: collapse(meta.verificationNote ?? ''),
    copyrightNote: collapse(meta.copyrightNote ?? ''),
    claims,
    summary,
  };
}

function parseClaims(
  body: string,
  file: string,
  meta: Record<string, string>,
  verification: DocumentVerification,
  defects: KnowledgeDefect[],
): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  const lines = body.split(/\r?\n/);
  let current: { id: string; grounding: Grounding; fields: Record<string, string> } | null = null;
  let inSummary = false;

  const flush = (): void => {
    if (!current) return;
    const f = current.fields;
    const text = collapse(f['claim'] ?? '');
    if (text === '') {
      defects.push({
        file,
        severity: 'error',
        message: `claim ${current.id} has no \`claim:\` text`,
      });
    }
    claims.push({
      id: current.id,
      text,
      grounding: current.grounding,
      documentId: meta.id ?? file,
      documentTitle: meta.title ?? file,
      documentUrl: f['source_url'] ?? meta.sourceUrl ?? '',
      documentVerification: verification,
      locator: collapse(f['locator'] ?? 'unstated'),
      quote: collapse(f['quote'] ?? ''),
      unknownReason: collapse(f['unknown_reason'] ?? ''),
      derivation: collapse(f['derivation'] ?? ''),
      topics: (f['topics'] ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    });
    current = null;
  };

  for (const line of lines) {
    if (/^##\s+Summary\s*$/.test(line)) {
      inSummary = true;
      continue;
    }
    const heading = CLAIM_HEADING.exec(line);
    if (heading) {
      flush();
      inSummary = false;
      current = {
        id: heading[1]!,
        grounding: heading[2] as Grounding,
        fields: {},
      };
      continue;
    }
    if (current) {
      const field = /^-\s+\*\*([a-z_]+)\*\*\s*:\s*(.*)$/.exec(line);
      if (field) {
        current.fields[field[1]!] = (current.fields[field[1]!] ?? '') + ' ' + (field[2] ?? '');
      } else if (line.trim() !== '' && !line.startsWith('-')) {
        // Continuation of a multi-line field.
        for (const key of Object.keys(current.fields)) {
          if ((current.fields[key] ?? '').trimEnd().endsWith('"') === false) {
            current.fields[key] = (current.fields[key] ?? '') + ' ' + line.trim();
            break;
          }
        }
      }
    }
  }
  flush();

  // Grounding values outside the enum would already have been rejected by the
  // heading regex, so anything reaching here is structurally sound.
  for (const claim of claims) {
    if (!GROUNDINGS.includes(claim.grounding)) {
      defects.push({ file, severity: 'error', message: `claim ${claim.id} has invalid grounding` });
    }
  }

  return claims;
}

/** Minimal frontmatter parser: `key: value`, with `>` block scalars. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  let activeKey: string | null = null;
  let buffer: string[] = [];

  const commit = (): void => {
    if (activeKey) out[camel(activeKey)] = collapse(buffer.join(' '));
    activeKey = null;
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*#/.test(line) && activeKey === null) continue;
    if (line.trim() === '') {
      if (activeKey) buffer.push('');
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      commit();
      activeKey = kv[1]!;
      buffer = [kv[2] ?? ''];
    } else if (activeKey) {
      buffer.push(line.trim());
    }
  }
  commit();
  return out;
}

/** `source_url` and `sourceUrl` should both address the same field. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function collapse(value: string): string {
  // Only whitespace is normalised. Quotes are left alone: collapsing space next
  // to a quote character turns the words "Presidential", "Government" into
  // the words"Presidential","Government", which corrupts verbatim quotation.
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim();
}

function pick<T extends string>(value: string | undefined, allowed: T[]): T | null {
  if (value === undefined) return null;
  const found = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  return found ?? null;
}
