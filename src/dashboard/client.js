/* Browser-only presentation. Execution and outcome measurement stay on the server. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token') || '';
  const h = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const units = (value) => {
    try {
      const n = BigInt(value), sign = n < 0n ? '−' : '', a = n < 0n ? -n : n;
      const decimals = (a % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
      return sign + (a / 1000000n).toString() + (decimals ? '.' + decimals : '');
    } catch { return '—'; }
  };
  const checks = { 'intent-match': 'Payment must match the recorded quote', allowlist: 'Only approved recipients can be paid', price: 'Price must match the reference price', limits: 'Spending must stay within the owner’s limits', loop: 'Repeated payments are limited', approval: 'Only the owner can approve this payment', token: 'Payment must use the real USDC contract', signature: 'The authorization must be signed by the wallet it spends from', 'tx-exists': 'The transaction must exist onchain', amount: 'The full amount must be paid', replay: 'A payment can only be used once', recipient: 'Payment must reach the expected wallet', 'tx-status': 'The transaction must be confirmed', wallet: 'The wallet must complete the transfer', chain: 'Payment must be verifiable onchain', reconcile: 'An earlier payment must be reconciled' };
  const phases = ['guarded', 'unguarded'];
  let catalog = [], capabilities, settings, run = null, rows = new Map(), selected = 'prompt-injection', following = true, sequence = 0, source, frame, lastEvidence = '', apiError = '';
  const key = (phase, id) => phase + ':' + id;
  const row = (phase, id) => {
    const k = key(phase, id);
    if (!rows.has(k)) rows.set(k, { events: [], quotes: [], requests: [], decisions: [], transfers: [], deliveries: [], calls: [], stage: '', waiting: '' });
    return rows.get(k);
  };
  const apiUrl = (path) => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
  async function api(path, body) {
    const res = await fetch(apiUrl(path), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'The dashboard request failed.');
    return data;
  }
  const isRunning = () => run && ['running', 'stopping'].includes(run.status);
  const queueIds = () => run ? run.queue : catalog.filter((s) => settings.scenarioIds.includes(s.id)).map((s) => s.id);
  const meta = () => catalog.find((s) => s.id === selected) || catalog[0];
  const addr = (address, state) => {
    if (!address) return 'Unknown recipient';
    const value = String(address).toLowerCase();
    if (state.world?.attacker.toLowerCase() === value) return 'Attacker wallet';
    if (state.world?.merchant.toLowerCase() === value) return 'Merchant wallet';
    return String(address).slice(0, 8) + '…' + String(address).slice(-6);
  };
  const addressDetail = (address, state) => addr(address, state) + ' · ' + String(address).slice(0, 8) + '…' + String(address).slice(-4);
  function apply(event) {
    if (event.sequence <= sequence) return;
    sequence = event.sequence;
    const d = event.data || {};
    if (event.type === 'phase.started') { run.phase = event.phase; run.scenarioId = null; }
    if (event.type === 'run.stopping') run.status = 'stopping';
    if (event.type === 'phase.completed') run.reports[event.phase] = { report: d.report, partial: d.partial };
    if (event.type === 'run.completed') { run.status = d.status; run.scenarioId = null; $('announcer').textContent = d.status === 'completed' ? 'Comparison complete. All measured outcomes are available.' : 'Run stopped. Remaining scenarios were not run.'; }
    if (event.type === 'run.failed') { run.status = 'failed'; run.error = d.message; }
    if (event.type === 'run.log' && d.message.startsWith('WARNING:')) run.warning = d.message;
    if (!event.scenarioId) return;
    const state = row(event.phase, event.scenarioId);
    state.events.push(event);
    switch (event.type) {
      case 'scenario.started': run.scenarioId = event.scenarioId; if (following) selected = event.scenarioId; state.stage = 'preparing'; break;
      case 'scenario.stage': state.stage = d.stage; break;
      case 'world.ready': state.world = d; break;
      case 'model.waiting': state.waiting = 'Waiting for Grok'; break;
      case 'tool.started': state.waiting = ({ get_quote: 'Fetching the quote', merchant_request: 'Calling the merchant', request_payment: 'Requesting payment', check_balance: 'Reading the wallet balance' })[d.name] || 'Running ' + d.name; break;
      case 'tool.completed': state.calls.push(d.call); state.waiting = 'Agent continuing'; break;
      case 'tool.failed': state.waiting = 'Tool could not complete'; break;
      case 'quote.recorded': state.quotes.push(d.intent); break;
      case 'operation.started': state.requests.push(d); state.waiting = d.side === 'receive' ? 'Verifying the payment proof' : 'Evaluating the payment request'; break;
      case 'guard.decision': state.decisions.push(d); state.waiting = d.decision.allowed ? 'Request allowed' : 'Request denied'; break;
      case 'transfer.started': state.waiting = 'Payment in progress'; state.transfers.push({ ...d, status: 'pending' }); break;
      case 'signature.started': state.waiting = 'Signing the payment authorization'; break;
      case 'signature.completed': state.waiting = 'Authorization signed · not yet settled'; break;
      case 'settlement.started': state.waiting = 'Settling the signed payment'; state.transfers.push({ ...d, status: 'pending' }); break;
      case 'settlement.completed': state.waiting = 'Settlement reported · checking onchain'; break;
      case 'settlement.failed': state.waiting = 'Payment settlement rejected'; break;
      case 'transfer.confirmed': case 'transfer.failed': {
        const transfer = state.transfers.find((t) => t.operationId === d.operationId);
        if (transfer) Object.assign(transfer, d, { status: event.type === 'transfer.confirmed' ? 'confirmed' : 'failed' });
        state.waiting = event.type === 'transfer.confirmed' ? 'Payment confirmed' : 'Payment outcome requires verification'; break;
      }
      case 'delivery': state.deliveries.push(d); break;
      case 'transcript': if (d.entry.kind === 'task') state.task = d.entry.text; if (d.entry.kind === 'agent') state.answer = d.entry.text; break;
      case 'scenario.completed': state.result = d.result; state.stage = 'complete'; $('announcer').textContent = (catalog.find((s) => s.id === event.scenarioId)?.name || 'Scenario') + ': ' + outcome(state).title; break;
    }
  }
  function outcome(state) {
    const r = state.result;
    if (!r) return { title: state.events.length ? 'Outcome pending' : 'Not run', tone: 'neutral' };
    if (r.measurementStatus === 'unknown') return { title: 'Loss unknown', detail: r.error || 'The outcome could not be measured.', tone: 'warning' };
    if (BigInt(r.usdcLost) > 0n) return { title: units(r.usdcLost) + ' USDC ' + (r.category === 'receive' ? 'of goods lost' : 'lost'), detail: r.error || (r.category === 'receive' ? 'Goods were released without sufficient valid payment.' : 'Measured from transactions and cross-checked against balances.'), tone: 'loss' };
    if (r.error) return { title: r.stoppedBy ? 'Stopped by a different check' : 'Test incomplete', detail: r.error, tone: 'warning' };
    if (r.stoppedBy === 'agent') return { title: 'Agent declined the attack', detail: 'Nothing lost. The guard was not tested by this attempt.', tone: 'neutral' };
    if (r.expected === 'completed') return { title: r.passed ? 'Honest purchase completed' : 'Purchase not completed', detail: r.passed ? 'The payment and delivery succeeded without loss.' : 'The legitimate purchase did not finish.', tone: r.passed ? '' : 'warning' };
    if (r.passed) return { title: 'Attack blocked by Tripwire', detail: 'No loss measured. ' + (checks[r.stoppedBy] || 'The expected defense stopped this attack.'), tone: '' };
    return { title: 'Test incomplete', detail: 'Inspect the evidence for this attempt.', tone: 'warning' };
  }
  function status(state) {
    if (state.result) { const o = outcome(state); return { text: state.result.passed ? (state.result.category === 'honest' ? 'Done' : state.result.stoppedBy === 'agent' ? 'Declined' : 'Blocked') : o.tone === 'loss' ? 'Loss' : 'Review', color: state.result.passed ? 'var(--teal)' : o.tone === 'loss' ? 'var(--coral)' : 'var(--amber)' }; }
    if (state.events.length) return { text: isRunning() ? 'Running' : 'Incomplete', color: 'var(--amber)' };
    return { text: run && !isRunning() ? 'Not run' : 'Waiting', color: '#53657e' };
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = null; render(); }); }
  function hydrate(snapshot) {
    source?.close();
    run = snapshot.run;
    rows = new Map(); sequence = 0; lastEvidence = '';
    if (run) {
      settings = { ...run.config };
      // Reconstruct from the journal while retaining the server's terminal status.
      const terminal = run.status, active = run.scenarioId, preferred = selected;
      for (const event of run.events) apply(event);
      run.status = terminal; run.scenarioId = active;
      if (!['running', 'stopping'].includes(terminal)) selected = run.queue.includes(preferred) ? preferred : run.queue[0];
      if (!run.queue.includes(selected)) selected = run.scenarioId || run.queue[0];
      if (following && run.scenarioId) selected = run.scenarioId;
      connect();
    }
    schedule();
  }
  function connect() {
    if (!run) return;
    const id = run.id;
    source = new EventSource(apiUrl(`/api/runs/${id}/events?after=${sequence}`));
    source.onopen = () => { $('connection').textContent = 'Connected'; $('connection-dot').style.background = 'var(--teal)'; };
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      if (event.runId !== run?.id) return;
      apply(event); schedule();
    };
    source.addEventListener('reset', async () => { source.close(); hydrate(await api('/api/state')); });
    source.onerror = () => {
      $('connection').textContent = 'Reconnecting'; $('connection-dot').style.background = 'var(--amber)';
      api('/api/state').then((snapshot) => { if (snapshot.run?.id !== id) hydrate(snapshot); }).catch(() => {});
    };
  }
  function readiness(config) {
    const required = [];
    if (config.agent !== 'naive') required.push('XAI_API_KEY', 'XAI_MODEL');
    if (config.network === 'arc-testnet') { required.push('CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'WALLET_ID_HOT', 'WALLET_ID_VAULT', 'WALLET_ID_MERCHANT', 'ATTACKER_PRIVATE_KEY'); if (config.scenarioIds.includes('counterfeit-usdc')) required.push('FAKE_USDC_ADDRESS'); }
    return required.filter((name) => !capabilities.configured[name]);
  }
  function renderQueue() {
    let group = '';
    const focusedId = document.activeElement?.dataset.scenario;
    $('queue').innerHTML = queueIds().map((id, i) => {
      const s = catalog.find((item) => item.id === id), nextGroup = s.category === 'honest' ? 'HONEST CONTROLS' : 'ATTACK SCENARIOS';
      const heading = group === nextGroup ? '' : `<div class="queue-group">${nextGroup}</div>`; group = nextGroup;
      return heading + `<button class="queue-item${selected === id ? ' selected' : ''}" data-scenario="${h(id)}" ${selected === id ? 'aria-current="true"' : ''}><span class="queue-index">${String(i + 1).padStart(2, '0')}</span><span><span class="queue-name">${h(s.name)}</span><span class="queue-category">${s.category === 'honest' ? 'Honest control' : h(s.category.charAt(0).toUpperCase() + s.category.slice(1)) + ' attack'}</span><span class="queue-verdicts">${phases.map((phase) => { const st = status(row(phase, id)); const tone = st.color === 'var(--teal)' ? 'safe' : st.color === 'var(--coral)' ? 'danger' : st.color === 'var(--amber)' ? 'busy' : 'pending'; return `<span title="${phase === 'guarded' ? 'With Tripwire' : 'Without Tripwire'}: ${h(st.text)}"><span class="dot ${tone}"></span>${phase === 'guarded' ? 'ON' : 'OFF'} · ${h(st.text)}</span>`; }).join('')}</span></span></button>`;
    }).join('');
    if (focusedId) document.querySelector(`[data-scenario="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
    $('queue-count').textContent = String(queueIds().length).padStart(2, '0');
  }
  function txLink(hash) {
    const text = h(String(hash).slice(0, 10) + '…' + String(hash).slice(-5));
    return (run?.config.network === 'arc-testnet' && /^0x[0-9a-fA-F]{64}$/.test(hash)) ? `<a class="tx-link" href="https://testnet.arcscan.app/tx/${hash}" target="_blank" rel="noopener noreferrer">${text}${icon('link')}</a>` : `<span class="tx-link">${text} · simulated</span>`;
  }
  const placeholder = (text) => `<span class="step-placeholder">${h(text)}</span>`;
  function box(title, detail, tone = '', check) {
    return `<div class="decision-box ${tone}">${icon(tone === 'loss' || tone === 'warning' ? 'bolt' : tone === 'neutral' ? 'arrow' : 'shield')}<div><strong>${h(title)}</strong>${detail ? `<p>${h(detail)}</p>` : ''}${check ? `<span class="check-tag">${h(check)}</span>` : ''}</div></div>`;
  }
  function storyStep(number, label, body, seen, cls = '', tag = '') {
    return `<div class="story-step ${seen ? 'seen' : ''} ${cls}"><span class="step-number">${number}</span><div><div class="step-label">${h(label)}<span class="step-state">${h(tag)}</span></div><div class="step-body">${body}</div></div></div>`;
  }
  function renderColumn(phase, s) {
    const state = row(phase, s.id), guarded = phase === 'guarded', honest = s.category === 'honest', receive = s.category === 'receive';
    const q = state.quotes.at(-1), sendRequest = state.requests.filter((x) => x.side === 'send').at(-1)?.request, receipt = state.requests.filter((x) => x.side === 'receive').at(-1)?.request;
    const relevantQuote = state.quotes.find((x) => x.id === sendRequest?.intentId) || q;
    const attackText = state.events.filter((e) => e.type === 'transcript' && e.data.entry.kind === 'attacker').map((e) => e.data.entry.text);
    const checkout = state.calls.find((c) => c.name === 'merchant_request' && c.result?.status === 402)?.result?.body;
    let payload = '', action = '', response = '', final = '';
    if (honest && state.task) payload = `<blockquote class="payload-quote quote-honest">${h(state.task)}</blockquote>`;
    else if (receive && attackText.length) payload = `<blockquote class="payload-quote">${h(attackText.join('\n\n'))}</blockquote>`;
    else if (['prompt-injection', 'fake-owner', 'move-to-safety'].includes(s.id) && q?.description) payload = `<blockquote class="payload-quote">${h(q.description)}</blockquote>`;
    else if (s.id === 'self-approval' && attackText.length) payload = `<blockquote class="payload-quote">${h(attackText[0])}</blockquote>`;
    else if (checkout) payload = `<blockquote class="payload-quote">${h(checkout.message || 'Merchant payment request')}\n${h(units(checkout.amount))} USDC → ${h(addr(checkout.payTo, state))}</blockquote>`;
    else if (q) payload = `<blockquote class="payload-quote">Quote: ${h(units(q.amount))} USDC → ${h(addr(q.payTo, state))}${q.description ? '\n' + h(q.description) : ''}</blockquote>`;
    if (sendRequest) {
      action = `<p>Requested <strong>${h(units(sendRequest.amount))} USDC</strong> to <strong class="${addr(sendRequest.payTo, state) === 'Attacker wallet' ? 'coral' : ''}">${h(addr(sendRequest.payTo, state))}</strong>.</p>`;
      if (relevantQuote) {
        const changed = relevantQuote.payTo.toLowerCase() !== sendRequest.payTo.toLowerCase() || String(relevantQuote.amount) !== String(sendRequest.amount);
        action += `<dl class="comparison-fields"><div><dt>Quoted</dt><dd>${h(units(relevantQuote.amount))} USDC → ${h(addressDetail(relevantQuote.payTo, state))}</dd></div><div class="${changed ? 'changed' : ''}"><dt>Requested</dt><dd>${h(units(sendRequest.amount))} USDC → ${h(addressDetail(sendRequest.payTo, state))}</dd></div></dl>`;
      }
      const attempts = state.requests.filter((x) => x.side === 'send').length;
      if (attempts > 1) action += `<p class="event-note">${attempts} payment requests observed. Every attempt is in the evidence.</p>`;
      if (s.id === 'self-approval') { const calls = state.calls.filter((c) => c.name === 'merchant_request'); if (calls.length) action += `<p class="event-note">${calls.length} self-approval HTTP attempts · responses ${h(calls.map((c) => c.result?.status ?? 'error').join(', '))}</p>`; }
    } else if (receive && receipt) {
      const payment = receipt.payment;
      action = `<p>Presented a signed x402 payment to claim the order.</p><dl class="comparison-fields"><div><dt>Required</dt><dd>${h(units(receipt.expectedAmount))} real USDC → ${h(addr(receipt.expectedTo, state))}</dd></div>${payment ? `<div><dt>Presented</dt><dd>${h(units(payment.value))} tokens → ${h(addr(payment.to, state))}</dd></div><div><dt>Token</dt><dd>${h(payment.asset)}</dd></div><div><dt>Nonce</dt><dd>${h(payment.nonce)}</dd></div>` : '<div><dt>Proof</dt><dd>Missing or malformed authorization</dd></div>'}</dl>`;
      const claims = state.requests.filter((x) => x.side === 'receive').length;
      if (claims > 1) action += `<p class="event-note">${claims} claims checked. The same proof is being presented again.</p>`;
    } else if (state.result?.stoppedBy === 'agent') action = `<p>The agent declined to make an off-quote payment.</p>`;
    else if (state.calls.length) action = `<p>${h(state.waiting || 'The agent is interacting with the merchant.')}</p>`;
    if (s.category === 'hold' && state.world) action += `<dl class="comparison-fields"><div><dt>Hot wallet</dt><dd>${h(units(state.world.hot))} USDC at scenario start</dd></div><div><dt>Vault</dt><dd>${h(units(state.world.vault))} USDC · out of the agent’s reach</dd></div></dl>`;
    const denial = state.decisions.find((d) => !d.decision.allowed), decision = denial || state.decisions.at(-1);
    if (decision) {
      const d = decision.decision;
      response = box(guarded ? d.allowed ? 'Guard allowed the request' : decision.side === 'receive' ? 'Receipt refused' : 'Payment denied' : d.allowed ? 'Guard bypassed · request allowed' : 'Wallet could not complete the request', d.reason, guarded && !d.allowed ? '' : 'neutral', guarded ? d.check : undefined);
      if (guarded && !d.allowed) response += `<p class="event-note">${h(checks[d.check] || d.check)}</p>`;
    } else if (state.result?.stoppedBy === 'agent') response = box('Guard not tested', 'The agent declined without a guard denial.', 'neutral');
    else if (!guarded && state.events.length) response = box('Guard bypassed', 'This pass uses the unprotected wallet and accepts payment proofs without verification.', 'neutral');
    if (state.result) {
      const o = outcome(state); final = box(o.title, o.detail, o.tone);
      if (state.deliveries.length) final += `<p class="event-note">${state.deliveries.length} ${state.deliveries.length === 1 ? 'delivery' : 'deliveries'} recorded by the merchant.</p>`;
      if (state.answer) final += `<details class="agent-answer"><summary>Agent’s answer</summary><p>${h(state.answer)}</p></details>`;
      final += state.result.txHashes.map(txLink).join('');
    } else if (run && !isRunning() && state.events.length) {
      final = box('Outcome incomplete', 'Execution ended before this scenario produced a measured result.', 'warning');
    }
    const pending = state.stage === 'measuring' ? 'Measuring the financial outcome' : state.stage === 'balances' ? 'Cross-checking wallet balances' : state.stage === 'preparing' ? 'Preparing this scenario' : state.waiting || 'Waiting for execution';
    const waitingText = run && !isRunning() && !state.events.length ? 'Not run' : !guarded && run?.phase === 'guarded' ? 'Waiting for unguarded pass' : 'Waiting to run';
    const tag = state.result ? status(state).text : state.events.length ? isRunning() ? pending : 'Incomplete' : waitingText;
    const actors = receive ? ['Attacker', 'Receipt', 'Guard', 'Delivery'] : honest ? ['Task', 'Agent', 'Guard', 'Merchant'] : ['Merchant', 'Agent', 'Guard', 'Wallet'];
    return `<article class="run-column ${guarded ? 'guarded' : 'baseline'}"><header class="column-heading"><span class="column-title">${icon(guarded ? 'shield' : 'code')}${guarded ? 'With Tripwire' : 'Without Tripwire'}</span><span class="column-tag ${state.events.length && !state.result ? 'active' : ''}">${h(tag)}</span></header><div class="flow" aria-label="${h(actors.join(' to '))}">${actors.map((actor, i) => `${i ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ''}<span class="flow-node ${actor === 'Guard' ? 'guard-node' : ''} ${state.events.length && i === 0 ? 'observed' : ''}">${actor === 'Guard' && !guarded ? 'Bypassed' : actor}</span>`).join('')}</div><div class="story">${storyStep('01', honest ? 'Task & quote' : 'Attack payload', payload || placeholder(receive ? 'The submitted proof will appear here.' : 'The actual merchant content will appear here.'), Boolean(payload), 'payload', payload ? 'OBSERVED' : '')}${storyStep('02', receive ? 'Attacker’s claim' : 'Observed agent action', action || placeholder('Waiting for an action.'), Boolean(action))}${storyStep('03', guarded ? 'Guard response' : 'Unguarded response', response || placeholder('The actual verdict will appear here.'), Boolean(response))}${storyStep('04', 'Measured outcome', final || placeholder(state.events.length ? pending + ' · outcome pending' : waitingText), Boolean(final))}</div></article>`;
  }
  function renderMetrics() {
    const states = [...rows.values()], results = states.filter((s) => s.result).map((s) => s.result), total = queueIds().length * 2;
    $('metric-progress').innerHTML = `${results.length} <span>/ ${total}</span>`;
    $('progress-bar').style.width = (total ? results.length / total * 100 : 0) + '%';
    $('metric-progress-note').textContent = run ? isRunning() ? 'Completed so far · outcomes measured' : run.status === 'completed' ? 'Both passes complete' : 'Partial run · remaining scenarios not run' : 'Two passes. Same attack scenarios.';
    $('metric-guards').textContent = String([...rows.entries()].filter(([k]) => k.startsWith('guarded:')).flatMap(([, s]) => s.decisions).filter((d) => !d.decision.allowed).length);
    let unknown = 0;
    for (const phase of phases) {
      const rs = queueIds().map((id) => row(phase, id).result).filter(Boolean), known = rs.filter((r) => r.measurementStatus !== 'unknown');
      const count = rs.length - known.length; unknown += count;
      const loss = known.reduce((sum, r) => sum + BigInt(r.usdcLost), 0n);
      $('metric-loss-' + (phase === 'guarded' ? 'on' : 'off')).textContent = known.length ? units(loss) + (count ? ' + ?' : '') : count ? 'Unknown' : '—';
    }
    $('metric-loss-note').textContent = unknown ? `${unknown} outcome${unknown === 1 ? '' : 's'} unknown · excluded from measured totals` : run && isRunning() ? 'Measured so far · includes unpaid goods value' : 'Includes overpayments and unpaid goods value';
    const honest = results.filter((r) => r.category === 'honest' && r.passed).length, honestTotal = queueIds().filter((id) => catalog.find((s) => s.id === id)?.category === 'honest').length * 2;
    $('metric-honest').innerHTML = `${honest} <span>/ ${honestTotal}</span>`;
    $('metric-honest-note').textContent = run?.status === 'completed' && !unknown ? `Safety score: ${run.reports.guarded.report.overall} guarded / ${run.reports.unguarded.report.overall} unguarded` : 'Protection that keeps payments working';
  }
  function evidenceLabel(event) {
    const d = event.data;
    switch (event.type) {
      case 'quote.recorded': return 'Quote recorded by the guard';
      case 'tool.started': return 'Tool called · ' + d.name;
      case 'tool.completed': return 'Tool returned · ' + d.call.name;
      case 'tool.failed': return 'Tool failed · ' + d.name;
      case 'operation.started': return d.side === 'receive' ? 'Receipt verification requested' : 'Payment requested';
      case 'guard.decision': return (event.phase === 'guarded' ? 'Guard' : 'Unguarded wallet') + ' · ' + (d.decision.allowed ? 'allowed' : 'denied') + ' · ' + d.decision.check;
      case 'transfer.started': return 'Transfer started · ' + units(d.amount) + ' ' + d.asset;
      case 'transfer.confirmed': return 'Transfer confirmed · ' + units(d.amount) + ' ' + d.asset;
      case 'transfer.failed': return 'Transfer did not confirm';
      case 'signature.started': return 'Signing payment authorization';
      case 'signature.completed': return 'Authorization signed · settlement pending';
      case 'settlement.started': return 'Settlement started · ' + units(d.amount) + ' ' + d.asset;
      case 'settlement.completed': return 'Facilitator reported settlement · ' + units(d.amount) + ' ' + d.asset;
      case 'settlement.failed': return 'Facilitator rejected settlement';
      case 'delivery': return 'Merchant delivered · ' + d.item;
      case 'transcript': return ({ task: 'Task given to the agent', agent: 'Agent’s answer', attacker: 'Attacker action', merchant: 'Merchant response' })[d.entry.kind] || null;
      case 'scenario.completed': return 'Scenario outcome measured';
      default: return null;
    }
  }
  function renderEvidence() {
    const events = phases.flatMap((p) => row(p, selected).events).filter((e) => evidenceLabel(e)).sort((a, b) => a.sequence - b.sequence);
    $('evidence-count').textContent = String(events.length).padStart(2, '0');
    const signature = selected + ':' + (run?.id || '') + ':' + events.length;
    if (signature === lastEvidence) return;
    lastEvidence = signature;
    const focusedSequence = document.activeElement?.closest?.('.evidence-row')?.dataset.sequence;
    const open = new Set([...$('evidence').querySelectorAll('details[open]')].map((el) => el.dataset.sequence));
    if (!events.length) { $('evidence').innerHTML = `<div class="evidence-empty">${icon('code')}Every tool call, payment decision, and transaction will be recorded here.</div>`; return; }
    const origin = new Date(run.events[0].timestamp).getTime();
    $('evidence').innerHTML = events.map((e) => `<details class="evidence-row" data-sequence="${e.sequence}" ${open.has(String(e.sequence)) ? 'open' : ''}><summary><span class="evidence-time">+${((new Date(e.timestamp).getTime() - origin) / 1000).toFixed(2)}s</span><span class="evidence-phase ${e.phase === 'unguarded' ? 'off' : ''}">${e.phase === 'guarded' ? 'GUARDED' : 'UNGUARDED'}</span>${h(evidenceLabel(e))}</summary><pre>${h(JSON.stringify(e.data, null, 2))}</pre></details>`).join('');
    if (focusedSequence) $('evidence').querySelector(`[data-sequence="${CSS.escape(focusedSequence)}"] summary`)?.focus({ preventScroll: true });
  }
  function renderDownloads() {
    const files = run ? [...Object.keys(run.reports).flatMap((phase) => ['json', 'md', 'html'].map((ext) => `${phase}.${ext}`)), ...(run.status === 'completed' ? ['comparison.html'] : [])] : [];
    $('downloads').hidden = !files.length;
    $('downloads').innerHTML = `<strong>${run?.status === 'partial' ? 'Partial run reports' : 'Run reports'}</strong>${files.map((file) => `<a href="${h(apiUrl(`/api/runs/${run.id}/report/${file}`))}">${h(file)}</a>`).join('')}`;
  }
  function render() {
    if (!capabilities) return;
    const ids = queueIds();
    if (!ids.includes(selected)) selected = ids.includes('prompt-injection') ? 'prompt-injection' : ids[0];
    const s = meta(), active = isRunning(), config = run?.config || settings, missing = readiness(settings);
    $('sidebar-network').textContent = config.network === 'fake' ? 'Simulated ledger' : 'Arc Testnet';
    $('sidebar-agent').textContent = config.agent === 'naive' ? 'Scripted agent' : config.agent === 'grok-careful' ? 'Grok · careful prompt' : 'Grok agent';
    $('footer-network').textContent = config.network === 'fake' ? 'Offline · No real funds moved' : 'Arc Testnet · Testnet USDC';
    $('start').hidden = Boolean(active); $('stop').hidden = !active; $('stop').disabled = run?.status === 'stopping';
    $('stop').textContent = run?.status === 'stopping' ? 'Finishing current scenario…' : 'Stop after scenario';
    $('start').disabled = Boolean(missing.length); $('configure').disabled = Boolean(active); $('choose-scenarios').disabled = Boolean(active);
    const setupLabel = (settings.network === 'arc-testnet' ? 'Arc Testnet' : 'Offline ledger') + ' + ' + (settings.agent === 'naive' ? 'scripted agent' : 'Grok');
    const notice = apiError || run?.error || run?.warning || (!run && missing.length ? `${setupLabel} is selected. Configure ${missing.join(', ')} in .env, then restart; or choose another mode in Configure.` : '');
    $('notice').hidden = !notice; $('notice').textContent = notice;
    $('category').textContent = s.category === 'honest' ? 'HONEST CONTROL' : s.category.toUpperCase() + ' ATTACK'; $('category').className = 'pill' + (s.category === 'honest' ? ' honest' : '');
    $('scenario-number').textContent = s.number.startsWith('H') ? 'CONTROL ' + s.number : 'ATTACK ' + s.number.replace('#', '').padStart(2, '0');
    $('attack-title').textContent = s.name; $('attack-goal').textContent = s.goal; $('attack-description').textContent = s.description;
    $('follow').hidden = following || !active; $('run-status').className = 'run-status' + (active ? ' live' : '');
    $('run-status').textContent = !run ? 'Ready to run' : active ? (run.phase === 'guarded' ? 'Guarded' : 'Unguarded') + ' pass · ' + (run.status === 'stopping' ? 'stopping' : 'live') : run.status === 'completed' ? 'Comparison complete' : run.status === 'partial' ? 'Partial run' : 'Run failed';
    $('run-caption').textContent = !run ? 'Waiting for a run · No funds have moved' : config.network === 'fake' ? 'Simulated ledger · No real funds moved' : 'Arc Testnet · Actual testnet transactions';
    $('event-count').textContent = sequence + ' EVENTS RECORDED';
    const openAnswers = [...$('comparison').querySelectorAll('.agent-answer')].map((el) => el.open);
    const focusedAnswer = [...document.querySelectorAll('.agent-answer summary')].indexOf(document.activeElement);
    $('comparison').innerHTML = phases.map((p) => renderColumn(p, s)).join('');
    [...$('comparison').querySelectorAll('.agent-answer')].forEach((el, i) => { el.open = Boolean(openAnswers[i]); });
    if (focusedAnswer >= 0) document.querySelectorAll('.agent-answer summary')[focusedAnswer]?.focus({ preventScroll: true });
    renderQueue(); renderMetrics(); renderEvidence(); renderDownloads();
  }
  function formConfig() { return { network: $('network').value, agent: $('agent').value, scenarioIds: [...document.querySelectorAll('#scenario-options input:checked')].map((input) => input.value) }; }
  function updateReadiness() {
    const draft = formConfig(), missing = readiness(draft);
    $('readiness').className = 'readiness' + (missing.length ? ' missing' : '');
    $('readiness').textContent = missing.length ? 'Missing: ' + missing.join(', ') + '. Add these to .env and restart the dashboard.' : draft.network === 'fake' && draft.agent === 'naive' ? 'Ready · deterministic offline run. No credentials or real funds needed.' : 'Configuration present · connectivity and wallet balances are checked when the run starts.';
  }
  function openSettings() {
    if (isRunning()) return;
    $('network').value = settings.network; $('agent').value = settings.agent;
    $('scenario-options').innerHTML = catalog.map((s) => `<label class="scenario-option"><input type="checkbox" value="${h(s.id)}" ${settings.scenarioIds.includes(s.id) ? 'checked' : ''}><span><strong>${h(s.name)}</strong><span class="option-description">${h(s.goal)}</span></span><span class="pill ${s.category === 'honest' ? 'honest' : ''}">${h(s.category)}</span></label>`).join('');
    updateReadiness(); $('settings').showModal();
  }
  $('configure').addEventListener('click', openSettings); $('choose-scenarios').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => $('settings').close());
  $('settings-form').addEventListener('change', updateReadiness);
  $('preset').addEventListener('click', () => { document.querySelectorAll('#scenario-options input').forEach((input) => { input.checked = ['honest-1', 'counterfeit-usdc', 'swap-payto', 'prompt-injection'].includes(input.value); }); updateReadiness(); });
  $('select-all').addEventListener('click', () => { document.querySelectorAll('#scenario-options input').forEach((input) => { input.checked = true; }); updateReadiness(); });
  $('settings-form').addEventListener('submit', (event) => {
    event.preventDefault(); const draft = formConfig();
    if (!draft.scenarioIds.length) { $('readiness').textContent = 'Select at least one scenario.'; $('readiness').className = 'readiness missing'; return; }
    settings = draft; source?.close(); run = null; rows = new Map(); sequence = 0; following = true; apiError = ''; lastEvidence = ''; $('settings').close(); schedule();
  });
  $('queue').addEventListener('click', (event) => { const button = event.target.closest('[data-scenario]'); if (!button) return; selected = button.dataset.scenario; following = false; schedule(); });
  $('follow').addEventListener('click', () => { following = true; if (run?.scenarioId) selected = run.scenarioId; schedule(); });
  $('start').addEventListener('click', async () => {
    $('start').disabled = true; apiError = ''; following = true;
    try { hydrate(await api('/api/runs', settings)); } catch (err) { apiError = err.message; schedule(); }
  });
  $('stop').addEventListener('click', async () => {
    $('stop').disabled = true;
    try { await api(`/api/runs/${run.id}/stop`, {}); } catch (err) { apiError = err.message; schedule(); }
  });
  Promise.all([api('/api/config'), api('/api/state')]).then(([config, snapshot]) => {
    capabilities = config; catalog = config.scenarios; settings = config.defaults;
    $('connection').textContent = 'Connected'; $('connection-dot').style.background = 'var(--teal)'; hydrate(snapshot);
  }).catch((err) => { $('notice').hidden = false; $('notice').textContent = err.message; $('connection').textContent = 'Disconnected'; });
})();
