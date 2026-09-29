/* ==========================================================================
   Bureaucracy Boss Fight - client
   Vanilla ES modules, no build step. The UI is thin on purpose: the engine
   decides what is true, and this file's only epistemic responsibility is to
   render the labels it is given without flattening them.
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  transcript: [],
  claims: [],
  documents: [],
  actions: [],
  labOn: true,
  lastLab: null,
  endingShown: false,
  busy: false,
};

/* ── Boot ───────────────────────────────────────────────────────────── */

async function boot() {
  wireEvents();
  try {
    const health = await api('/api/health');
    const chip = $('modeChip');
    chip.classList.add(health.mode === 'llm' ? 'is-llm' : 'is-demo');
    $('modeLabel').textContent = health.provider;
    $('startNote').textContent =
      `${health.knowledge.documents} source documents · ${health.knowledge.claims} labelled claims` +
      (health.mode === 'demo' ? ' · running the deterministic demo Game Master' : '');
    if (health.reason) {
      $('startNote').textContent = health.reason;
      $('startNote').classList.add('warn');
    }
  } catch (error) {
    $('startNote').textContent = `Cannot reach the server: ${error.message}`;
    $('startNote').classList.add('warn');
  }
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/* ── Events ─────────────────────────────────────────────────────────── */

function wireEvents() {
  $('startBtn').addEventListener('click', () => startGame($('seedInput').value));
  $('newGameBtn').addEventListener('click', () => {
    $('endingOverlay').hidden = true;
    state.endingShown = false;
    $('gameScreen').hidden = true;
    $('startScreen').hidden = false;
    $('seedInput').value = String(Math.floor(Math.random() * 2_000_000_000));
  });
  $('labToggle').addEventListener('click', () => {
    state.labOn = !state.labOn;
    $('labToggle').setAttribute('aria-pressed', String(state.labOn));
    if (state.labOn) switchTab('lab');
    if (state.session) {
      api(`/api/game/${state.session.id}/lab`, {
        method: 'POST',
        body: JSON.stringify({ visible: state.labOn }),
      }).catch(() => {});
    }
  });

  $('actionForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('actionInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submit(text);
  });

  for (const button of document.querySelectorAll('.rail-tab')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }

  $('replaySameSeed').addEventListener('click', () => {
    $('endingOverlay').hidden = true;
    startGame(String(state.session.seed));
  });
  $('newSeed').addEventListener('click', () => {
    $('endingOverlay').hidden = true;
    state.endingShown = false;
    $('gameScreen').hidden = true;
    $('startScreen').hidden = false;
    $('seedInput').value = String(Math.floor(Math.random() * 2_000_000_000));
  });

  // Delegated: citation chips and action-button clicks.
  document.addEventListener('click', (event) => {
    const cite = event.target.closest('.cite');
    if (cite) {
      switchTab('evidence');
      const target = document.getElementById(`claim-${cite.dataset.claim}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 1400);
      }
      return;
    }
    const action = event.target.closest('.action-btn');
    if (action) submit(action.dataset.example);
  });
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.rail-tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  $('tabEvidence').hidden = name !== 'evidence';
  $('tabLab').hidden = name !== 'lab';
  $('tabSources').hidden = name !== 'sources';
  if (name === 'sources' && state.documents.length === 0) loadSources();
}

/* ── Game lifecycle ─────────────────────────────────────────────────── */

async function startGame(seedValue) {
  const seed = Number.parseInt(seedValue, 10);
  setBusy(true, 'setting the scene…');
  try {
    const data = await api('/api/game/new', {
      method: 'POST',
      body: JSON.stringify({ seed: Number.isFinite(seed) ? seed : 20260929 }),
    });
    state.session = data.session;
    state.transcript = [];
    state.lastLab = null;
    state.endingShown = false;
    state.actions = data.actions;

    $('startScreen').hidden = true;
    $('gameScreen').hidden = false;
    $('endingOverlay').hidden = true;
    $('seedBadge').textContent = `seed ${data.session.seed}`;

    renderActionButtons();
    renderTranscript();
    renderState();

    await loadClaims();
    renderEvidence();
    renderLab();
    switchTab('evidence');
  } catch (error) {
    alert(`Could not start the run: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function submit(text) {
  if (!state.session || state.busy) return;
  if (state.session.status !== 'ACTIVE') return;

  setBusy(true, 'resolving…');
  try {
    const data = await api(`/api/game/${state.session.id}/action`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    state.session = data.session;
    state.transcript.push(data.turn);
    state.lastLab = data.lab;
    await loadClaims();
    renderState();
    renderTranscript();
    renderEvidence();
    renderLab();
    maybeShowEnding();
  } catch (error) {
    $('composerHint').textContent = `Error: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(on, label) {
  state.busy = on;
  $('busy').hidden = !on;
  if (label) $('busyText').textContent = label;
  $('sendBtn').disabled = on;
}

async function loadClaims() {
  try {
    const data = await api('/api/knowledge/claims');
    state.claims = data.claims;
  } catch {
    state.claims = [];
  }
}

async function loadSources() {
  try {
    const data = await api('/api/knowledge/documents');
    state.documents = data.documents;
    renderSources();
  } catch {
    state.documents = [];
  }
}

/* ── Render: mission panel ──────────────────────────────────────────── */

function renderState() {
  const s = state.session;
  if (!s) return;

  $('moneyValue').textContent = `KSh ${s.money.toLocaleString('en-KE')}`;
  $('moneyValue').classList.toggle('is-low', s.money <= 1000);
  $('turnValue').textContent = `${s.turn}/${s.maxTurns}`;
  $('dayValue').textContent = String(s.day);

  $('turnbar').innerHTML = Array.from({ length: s.maxTurns }, (_, i) => {
    const cls = i < s.turn ? 'used' : i === s.turn ? 'current' : '';
    return `<i class="${cls}"></i>`;
  }).join('');

  $('objectives').innerHTML = s.objectives
    .map((o) => {
      const mark = { COMPLETE: '✓', FAILED: '✕', ACTIVE: '▸', LOCKED: '·' }[o.status];
      return `<li class="${o.status.toLowerCase()}">
        <span class="obj-mark">${mark}</span>
        <span class="obj-text">
          <span class="obj-title"><span class="obj-kind obj-kind-${o.kind}">${o.kind}</span>${escapeHtml(o.title)}</span>
        </span>
      </li>`;
    })
    .join('');

  $('inventory').innerHTML = s.inventory.length
    ? s.inventory
        .map(
          (i) => `<li><span class="${i.official ? 'official' : ''}">${escapeHtml(i.label)}</span><span class="qty">×${i.quantity}</span></li>`,
        )
        .join('')
    : '<li class="empty">Nothing yet.</li>';

  const known = s.revealedClaims;
  const counts = { VERIFIED: 0, INFERRED: 0, UNKNOWN: 0 };
  for (const id of known) {
    const claim = state.claims.find((c) => c.id === id);
    if (claim && counts[claim.grounding] !== undefined) counts[claim.grounding] += 1;
  }
  $('evidenceCounts').innerHTML =
    `<span class="badge badge-verified">${counts.VERIFIED} verified</span>` +
    `<span class="badge badge-unknown">${counts.UNKNOWN} unknown</span>` +
    `<span class="badge badge-fictional">${known.length} total</span>`;

  const over = s.status !== 'ACTIVE';
  $('actionInput').disabled = over;
  $('sendBtn').disabled = over || state.busy;
  for (const b of document.querySelectorAll('.action-btn')) b.disabled = over;

  $('composerHint').textContent = over
    ? 'This run is over. Replay the same seed to try a different set of decisions.'
    : `${s.maxTurns - s.turn} turn(s) left. Reading costs a day, same as everything else.`;
}

function renderActionButtons() {
  $('actionButtons').innerHTML = state.actions
    .map(
      (a) =>
        `<button class="action-btn" type="button" title="${escapeAttr(a.example)}" data-example="${escapeAttr(a.example)}">${escapeHtml(a.label)}</button>`,
    )
    .join('');
}

/* ── Render: conversation ───────────────────────────────────────────── */

function renderTranscript() {
  const box = $('transcript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.innerHTML = state.transcript.map(renderTurn).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderTurn(turn) {
  const parts = [];

  parts.push(`<div class="turn-player"><span>${escapeHtml(turn.action || '(waiting)')}</span></div>`);

  const meta = [
    `turn ${turn.turn}`,
    `day ${turn.dayAfter}`,
    `KSh ${Number(turn.moneyAfter).toLocaleString('en-KE')}`,
    `<span class="tag">${escapeHtml(turn.actionType)} ${turn.confidence}</span>`,
  ];
  if (turn.optionId) meta.push(`<span class="tag">${escapeHtml(turn.optionId)}</span>`);
  if (turn.critique) {
    meta.push(
      `<span class="tag ${turn.critique.passed ? 'critic-pass' : 'critic-fail'}">critic ${turn.critique.score}</span>`,
    );
  }
  parts.push(`<div class="turn-meta">${meta.join(' · ')}</div>`);

  if (turn.rejection) {
    parts.push(
      `<div class="rejection">${escapeHtml(turn.rejection.message)}${
        turn.rejection.clarification ? ` ${escapeHtml(turn.rejection.clarification)}` : ''
      }</div>`,
    );
  }

  for (const block of turn.narration ?? []) {
    const cites = (block.claimIds ?? [])
      .map((id) => `<button class="cite" data-claim="${escapeAttr(id)}">${escapeHtml(id)}</button>`)
      .join(' ');
    parts.push(`
      <div class="block block-${escapeAttr(block.grounding)}">
        <div class="block-head">
          <span class="badge badge-${badgeClass(block.grounding)}">${escapeHtml(labelFor(block.grounding))}</span>
          ${cites}
        </div>
        <p>${escapeHtml(block.text)}</p>
      </div>`);
  }

  for (const event of turn.events ?? []) {
    parts.push(`
      <div class="event event-${escapeAttr(event.kind)} ${escapeAttr(event.severity ?? 'info')}">
        <div>
          <h5>${escapeHtml(event.title)}</h5>
          <p>${escapeHtml(event.body)}</p>
        </div>
      </div>`);
  }

  return `<div class="turn">${parts.join('')}</div>`;
}

const labelFor = (g) =>
  ({
    VERIFIED: 'VERIFIED',
    INFERRED: 'INFERRED',
    UNKNOWN: 'UNKNOWN',
    FICTIONAL_GAME_EVENT: 'SIMULATION',
  })[g] ?? g;

const badgeClass = (g) =>
  ({
    VERIFIED: 'verified',
    INFERRED: 'inferred',
    UNKNOWN: 'unknown',
    FICTIONAL_GAME_EVENT: 'fictional',
  })[g] ?? 'fictional';

/* ── Render: evidence rail ──────────────────────────────────────────── */

function renderEvidence() {
  if (!state.session) return;
  const known = new Set(state.session.revealedClaims);
  const groups = [
    { key: 'VERIFIED', title: 'Verified — from a source you can open' },
    { key: 'INFERRED', title: 'Inferred — drawn from sources, not stated in them' },
    { key: 'UNKNOWN', title: 'Unknown — the record does not answer this' },
  ];

  const sections = groups
    .map((group) => {
      const claims = state.claims.filter((c) => c.grounding === group.key);
      const body = claims
        .map((claim) => {
          const revealed = known.has(claim.id);
          return `
            <div class="claim ${escapeAttr(claim.grounding)} ${revealed ? '' : 'locked'}" id="claim-${escapeAttr(claim.id)}">
              <div class="claim-head">
                <span class="badge badge-${badgeClass(claim.grounding)}">${escapeHtml(labelFor(claim.grounding))}</span>
                <span class="claim-id">${escapeHtml(claim.id)}</span>
                <span class="claim-id">${escapeHtml(claim.locator)}</span>
              </div>
              <p class="claim-text">${escapeHtml(revealed ? claim.text : 'Not yet discovered in this run.')}</p>
              ${
                revealed && claim.grounding === 'UNKNOWN' && claim.unknownReason
                  ? `<p class="claim-reason">${escapeHtml(claim.unknownReason)}</p>`
                  : ''
              }
              ${
                revealed && claim.quote
                  ? `<blockquote class="claim-quote">${escapeHtml(claim.quote)}</blockquote>`
                  : ''
              }
              <div class="claim-src">
                ${escapeHtml(claim.documentTitle)} ·
                ${claim.documentUrl ? `<a href="${escapeAttr(claim.documentUrl)}" target="_blank" rel="noopener">source</a>` : 'no link'}
              </div>
            </div>`;
        })
        .join('');
      return `<div class="rail-h">${escapeHtml(group.title)} (${claims.length})</div>${body}`;
    })
    .join('');

  $('tabEvidence').innerHTML =
    `<div class="rail-note">
      Greyed-out claims exist in the knowledge base but you have not read them yet in this
      run. Everything you can cite, you can also open.
    </div>${sections}`;
}

/* ── Render: sources tab ────────────────────────────────────────────── */

function renderSources() {
  $('tabSources').innerHTML =
    `<div class="rail-note">
      Every real-world claim in this game comes from one of these documents. Nothing was
      written from memory. Where the sources disagree or are silent, the game says so
      rather than picking a side.
    </div>` +
    state.documents
      .map(
        (doc) => `
      <div class="source-doc">
        <h4>${escapeHtml(doc.title)}</h4>
        <div class="meta">
          <span class="verif-${escapeAttr(doc.verification)}">${escapeHtml(doc.verification)}</span> ·
          ${escapeHtml(doc.documentType)} · ${escapeHtml(doc.jurisdiction)} ·
          version ${escapeHtml(doc.versionDate)} · retrieved ${escapeHtml(doc.retrievedAt)}
        </div>
        <div class="meta">${doc.counts.VERIFIED ?? 0} verified · ${doc.counts.INFERRED ?? 0} inferred · ${doc.counts.UNKNOWN ?? 0} unknown</div>
        <p style="font-size:12.5px;color:var(--ink-2)">${escapeHtml(doc.summary)}</p>
        ${doc.sourceUrl ? `<a href="${escapeAttr(doc.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(doc.sourceUrl)}</a>` : ''}
      </div>`,
      )
      .join('');
}

/* ── Render: Lab mode ───────────────────────────────────────────────── */

function renderLab() {
  if (!state.labOn) return;
  const lab = state.lastLab;
  if (!lab) {
    $('tabLab').innerHTML = '<div class="lab-empty">Take an action and the internals of that decision will appear here.</div>';
    return;
  }

  const parts = [];

  parts.push(`<div class="lab-section">
    <div class="rail-h">Turn ${lab.turn} · provider ${escapeHtml(lab.provider)}</div>
    <dl class="lab-kv">
      <dt>parsed as</dt><dd>${escapeHtml(lab.parsedIntent.type)} (confidence ${lab.parsedIntent.confidence})</dd>
      <dt>slots</dt><dd>${escapeHtml(JSON.stringify(lab.parsedIntent.slots)) || '{}'}</dd>
      <dt>rules fired</dt><dd>${lab.rulesFired.map(escapeHtml).join(', ') || '—'}</dd>
    </dl>
  </div>`);

  parts.push(`<div class="lab-section">
    <div class="rail-h">Evidence retrieved (${lab.retrieval.returned.length})</div>
    ${
      lab.retrieval.returned.length
        ? lab.retrieval.returned
            .map(
              (c) => `<div class="lab-row">
                <span class="badge badge-${badgeClass(c.grounding)}">${escapeHtml(labelFor(c.grounding))}</span>
                <span class="grow">${escapeHtml(c.id)} · ${escapeHtml(c.document)} ${escapeHtml(c.locator)}</span>
                <span class="claim-id">${c.score}</span>
              </div>`,
            )
            .join('')
        : '<div class="lab-empty">Nothing matched.</div>'
    }
    <div class="lab-row" style="margin-top:6px">
      <span class="claim-id">citable:</span><span class="grow">${lab.retrieval.usable.length
        ? lab.retrieval.usable.map(escapeHtml).join(', ')
        : 'none'}</span>
    </div>
  </div>`);

  if (lab.retrieval.gaps.length) {
    parts.push(`<div class="lab-section">
      <div class="rail-h">Gaps reported (${lab.retrieval.gaps.length})</div>
      ${lab.retrieval.gaps
        .map(
          (g) => `<div class="lab-opt" style="border-left:3px solid var(--unknown)">
            <b>${escapeHtml(g.topic)}</b><br>${escapeHtml(g.reason)}
          </div>`,
        )
        .join('')}
    </div>`);
  }

  parts.push(`<div class="lab-section">
    <div class="rail-h">Options the engine computed</div>
    ${lab.optionsConsidered
      .map(
        (o) => `<div class="lab-opt ${o.id === lab.chosenOption?.id ? 'chosen' : ''} ${o.available ? '' : 'blocked'}">
          <b>${escapeHtml(o.id)}</b>${o.id === lab.chosenOption?.id ? ' ← chosen' : ''}<br>
          ${escapeHtml(o.summary)}
          ${o.unavailableReason ? `<br><span style="color:var(--red)">${escapeHtml(o.unavailableReason)}</span>` : ''}
        </div>`,
      )
      .join('')}
  </div>`);

  const before = lab.stateTransition.before;
  const after = lab.stateTransition.after;
  parts.push(`<div class="lab-section">
    <div class="rail-h">State transition</div>
    <div class="lab-row"><span class="claim-id">day</span><span class="grow">${before.day} → ${after.day}</span></div>
    <div class="lab-row"><span class="claim-id">money</span><span class="grow">KSh ${Number(before.money).toLocaleString('en-KE')} → KSh ${Number(after.money).toLocaleString('en-KE')}</span></div>
    <div class="lab-row"><span class="claim-id">claims</span><span class="grow">${before.revealedClaims.length} → ${after.revealedClaims.length}</span></div>
    <div class="lab-row"><span class="claim-id">status</span><span class="grow">${escapeHtml(after.status)}</span></div>
  </div>`);

  if (lab.refusedEffects.length) {
    parts.push(`<div class="lab-section">
      <div class="rail-h">Refused by the engine</div>
      ${lab.refusedEffects
        .map((r) => `<div class="lab-opt" style="border-left:3px solid var(--red)"><b>${escapeHtml(r.effect)}</b><br>${escapeHtml(r.reason)}</div>`)
        .join('')}
    </div>`);
  }

  if (lab.critic) {
    const c = lab.critic;
    parts.push(`<div class="lab-section">
      <div class="rail-h">Critic verdict · ${c.score} · ${c.passed ? 'PASS' : 'FAIL'}</div>
      <p style="font-size:12px;color:var(--ink-2)">${escapeHtml(c.summary)}</p>
      ${c.checks
        .map(
          (check) => `<div class="lab-check ${check.passed ? 'pass' : 'fail'}">
            <span class="mark">${check.passed ? '✓' : '✕'}</span>
            <span><b>${escapeHtml(check.name)}</b><br><span class="detail">${escapeHtml(check.detail)}</span></span>
          </div>`,
        )
        .join('')}
    </div>`);
  }

  $('tabLab').innerHTML = parts.join('');
}

/* ── Ending ─────────────────────────────────────────────────────────── */

function maybeShowEnding() {
  const s = state.session;
  if (s.status === 'ACTIVE' || state.endingShown || !s.ending) return;
  state.endingShown = true;

  $('endingGrade').textContent = s.ending.grade;
  $('endingGrade').className = `grade ${s.ending.grade}`;
  $('endingTitle').textContent = s.ending.title;
  $('endingBlurb').textContent = s.ending.blurb;

  const complete = s.objectives.filter((o) => o.status === 'COMPLETE').length;
  const failed = s.objectives.filter((o) => o.status === 'FAILED').length;
  const critiques = state.transcript.map((t) => t.critique).filter(Boolean);
  const mean = critiques.length
    ? (critiques.reduce((a, c) => a + c.score, 0) / critiques.length).toFixed(1)
    : '—';

  $('endingStats').innerHTML = `
    <div class="row"><span>Money left</span><b>KSh ${s.money.toLocaleString('en-KE')}</b></div>
    <div class="row"><span>Turns used</span><b>${s.turn} of ${s.maxTurns}</b></div>
    <div class="row"><span>In-world days</span><b>${s.day}</b></div>
    <div class="row"><span>Objectives complete</span><b>${complete} / ${s.objectives.length}</b></div>
    <div class="row"><span>Objectives failed</span><b>${failed}</b></div>
    <div class="row"><span>Claims discovered</span><b>${s.revealedClaims.length}</b></div>
    <div class="row"><span>Mean critic score</span><b>${mean}</b></div>
    <div class="row"><span>Seed</span><b>${s.seed}</b></div>`;

  $('endingOverlay').hidden = false;
}

/* ── Utilities ──────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
const escapeAttr = escapeHtml;

boot();
