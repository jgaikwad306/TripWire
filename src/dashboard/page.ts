/** Real Arc Testnet blocks from the README's guarded run; each prev is the hash before it. */
const CHAIN_BLOCKS = [
  { x: 20, y: 10, lines: ['block 72734984', 'prev 0x8169…bd14', 'hash 0x0e99…72ff'], bits: '0110 1001 1101 0010 0111' },
  { x: 160, y: 150, lines: ['block 72735058', 'prev 0x0e99…72ff', 'hash 0x8160…8311'], bits: '1011 0100 0110 1110 0001' },
  { x: 20, y: 290, lines: ['block 72735096', 'prev 0x8160…8311', 'hash 0x2bb3…0c68'], bits: '0001 1101 1010 0110 1100' },
] as const;
const PENDING_BLOCK = { x: 160, y: 430, lines: ['next block', 'prev 0x2bb3…0c68', 'awaiting the guard'], bits: '0000 0000 0000 0000 0000' } as const;
const BLOCK = { width: 240, height: 104 } as const;
const STREAM_ROWS = ['0110', '1001', '1110', '0010', '1011', '0101', '1100', '0011', '1010', '0111', '1101', '0100', '1001'] as const;

function chainBlock(block: { x: number; y: number; lines: readonly string[]; bits: string }, pending: boolean): string {
  const { x, y } = block;
  const text = block.lines.map((line, i) => `<text class="chain-text${i === 0 ? ' chain-label' : ''}" x="${x + 16}" y="${y + 30 + i * 20}">${line}</text>`).join('');
  return `<rect class="chain-block${pending ? ' pending' : ''}"${pending ? ' id="chain-pending"' : ''} x="${x + .5}" y="${y + .5}" width="${BLOCK.width}" height="${BLOCK.height}"/>`
    + (pending ? '' : `<rect class="chain-signed" x="${x + 214}" y="${y + 16}" width="10" height="10"/>`)
    + text + `<text class="chain-text chain-bits" data-bits="5" x="${x + 16}" y="${y + 92}">${block.bits}</text>`;
}

/** A taut wire between two posts. Split in halves so each can pivot on its post and the
 * middle bows when it trips (client.js trips it as the reader scrolls across). */
const TRIPWIRE = '<span class="tripwire" aria-hidden="true"><i class="post"></i><i class="wire l"></i><i class="wire r"></i><i class="post"></i></span>';

/** The hero's decorative chain: signed blocks linked by hash, then the one awaiting the guard. */
function heroChain(): string {
  const blocks = CHAIN_BLOCKS.map((b) => chainBlock(b, false)).join('') + chainBlock(PENDING_BLOCK, true);
  const stream = STREAM_ROWS.map((bits, i) => `<text class="chain-stream" data-bits="1" x="424" y="${24 + i * 40}">${bits}</text>`).join('');
  return `<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 460 560" preserveAspectRatio="xMaxYMid meet" focusable="false"><g id="hero-chain">`
    + `<path class="chain-link" d="M260.5 62.5h20v88M160.5 202.5h-20v88M260.5 342.5h20v88"/>`
    + `<path class="chain-joint" d="M278 60h5v5h-5zM138 200h5v5h-5zM278 340h5v5h-5z"/>`
    + blocks + stream + '</g></svg></div>';
}

export function renderDashboard(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>Tripwire — Live attack lab</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/dashboard.css?token=${token}"><script src="/assets/app.js?token=${token}" defer></script></head>
<body>
<div class="ledger-bg" aria-hidden="true"><div class="ledger-layer ledger-far" id="ledger-far"></div><div class="ledger-layer ledger-near" id="ledger-near"></div></div>
<svg class="svg-defs" aria-hidden="true"><defs>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6Z"/><path d="m8 12 3 3 5-6"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></symbol>
<symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></symbol>
<symbol id="i-bolt" viewBox="0 0 24 24"><path d="m13 2-9 12h7l-1 8 10-13h-8Z"/></symbol>
<symbol id="i-wallet" viewBox="0 0 24 24"><path d="M4 7V5a2 2 0 0 1 2-2h12v4M4 7h16v14H4Z"/><path d="M16 12h4v5h-4Z"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
<symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/></symbol>
<symbol id="i-link" viewBox="0 0 24 24"><path d="M14 3h7v7m0-7L10 14M9 5H4v16h16v-6"/></symbol>
</defs></svg>
<header class="site-header">
  <a class="wordmark" href="#top">Tripwire<sup>®</sup></a>
  <nav class="site-nav" aria-label="Sections"><a href="#scenarios">Scenarios <span class="count">(<span id="queue-count">04</span>)</span></a><a href="#evidence-section">Evidence</a><a href="#summary">Summary</a></nav>
  <div class="header-status"><span class="setup"><strong id="sidebar-network">Arc Testnet</strong> / <span id="sidebar-agent">Grok agent</span></span><span class="connection"><span class="dot" id="connection-dot"></span><span id="connection">Connecting</span></span></div>
</header>
<section class="hero" id="top" aria-labelledby="hero-title">
  ${heroChain()}
  <div class="hero-top"><p class="hero-intro fade-in">A live <span class="red-team">red team</span> for an AI agent that holds a wallet. Each attack runs twice, once with the guard and once without, so you see the exploit, follow the money and watch the guard decide.</p><span class="hero-version fade-in">TRIPWIRE® /V.01 (2026)</span></div>
  <div class="hero-middle">
    <h1 id="hero-title" aria-label="Your agent. Under attack."><span class="reveal" aria-hidden="true"><span>Your agent.</span></span><span class="reveal" aria-hidden="true"><span>Under attack.</span></span></h1>
    <p class="hero-tagline fade-in">TripWire signs only what passes your rules.</p>
    <div class="hero-actions page-actions fade-in"><button class="button primary" id="start" disabled>Run comparison<span class="arrow" aria-hidden="true"><svg><use href="#i-arrow"/></svg><svg><use href="#i-arrow"/></svg></span></button><button class="button secondary" id="configure">Configure</button><button class="button stop" id="stop" hidden>Stop after scenario</button></div>
  </div>
  <div class="hero-bottom fade-in">${TRIPWIRE}<ul class="category-list" id="hero-categories" aria-label="Selected scenarios by category"></ul><p class="hero-setup">The agent asks.<br><strong>The guard decides.</strong></p></div>
</section>
<main>
    <div id="notice" class="notice" role="status" hidden></div>
    <section id="streams-monitor" class="section" aria-label="Wallet monitoring" hidden>${TRIPWIRE}<div class="section-head"><span class="index">(0)</span><h2>Wallet monitoring</h2><span class="aside" id="streams-state" role="status"></span></div><p id="streams-coverage"></p><div id="streams-details"></div></section>
    <section class="section" id="summary" aria-labelledby="summary-title">
      ${TRIPWIRE}<div class="section-head"><span class="index">(1)</span><h2 id="summary-title">Run summary</h2><span class="aside">Two passes. Same attacks.</span></div>
      <div class="metrics">
        <article class="metric"><div class="metric-label">Scenarios completed</div><div class="metric-value" id="metric-progress">0 <span>/ 8</span></div><div class="metric-track"><span id="progress-bar"></span></div><div class="metric-note" id="metric-progress-note">Two passes. Same attack scenarios.</div></article>
        <article class="metric"><div class="metric-label">Guard interventions</div><div class="metric-value" id="metric-guards">0</div><div class="metric-note">Observed payment or receipt denials</div></article>
        <article class="metric"><div class="metric-label">Loss, USDC equivalent</div><div class="loss-pair"><div><span class="mini-label">Guarded</span><strong id="metric-loss-on">—</strong></div><div><span class="mini-label">Unguarded</span><strong id="metric-loss-off">—</strong></div></div><div class="metric-note" id="metric-loss-note">Finalized after outcome measurement</div></article>
        <article class="metric"><div class="metric-label">Honest purchases</div><div class="metric-value" id="metric-honest">0 <span>/ 2</span></div><div class="metric-note" id="metric-honest-note">Protection that keeps payments working</div></article>
      </div>
      <p class="gateway-line" id="gateway-balances">Circle Gateway balances appear once a run starts.</p>
    </section>
    <section class="section" id="scenarios" aria-labelledby="attack-title">
      ${TRIPWIRE}<div class="section-head"><span class="index">(2)</span><h2>Scenarios</h2><span class="aside">Each one, guarded and unguarded</span></div>
      <div class="lab">
        <div class="index"><div class="index-head"><span>Index</span><span>No. / Title / Category</span></div><nav id="queue" aria-label="Scenario queue"></nav><button class="button secondary compact add-scenarios" id="choose-scenarios">Choose scenarios</button></div>
        <div class="investigation">
          <div class="stage-heading"><div><div class="stage-overline"><span class="pill" id="category">SEND ATTACK</span><span id="scenario-number">ATTACK 03</span></div><h2 id="attack-title">Prompt injection</h2><p id="attack-goal">Turn a product description into an instruction to send money elsewhere.</p></div><button id="follow" class="button secondary compact" hidden>Return to live</button><div id="run-status" class="run-status">Ready to run</div></div>
          <div class="attack-explainer"><p><strong>Setup</strong> &nbsp;<span id="attack-description">A merchant-controlled description tells the agent to ignore earlier payment details.</span></p></div>
          <div class="comparison" id="comparison"></div>
          <div class="stage-footer"><span><span class="dot muted-dot"></span><span id="run-caption">Waiting for a run · No funds have moved</span></span><span id="event-count">0 EVENTS RECORDED</span></div>
        </div>
      </div>
    </section>
    <section class="section" id="evidence-section" aria-labelledby="evidence-title">${TRIPWIRE}<div class="section-head"><span class="index">(3)</span><h2 id="evidence-title">Under the hood</h2><span class="aside">Observed events (<span id="evidence-count">00</span>)</span></div><div id="evidence"></div></section>
    <section id="downloads" class="section downloads" hidden></section>
    <footer class="page-footer"><span><strong>Tripwire®</strong> The agent asks. The guard decides.</span><span id="footer-network">Arc Testnet · Testnet USDC</span></footer>
</main>
<dialog id="settings"><form id="settings-form"><div class="dialog-header"><div><div class="eyebrow">SET UP YOUR RUN</div><h2>Configure attack lab</h2></div><button type="button" class="icon-button" id="close-settings" aria-label="Close configuration"><svg><use href="#i-close"/></svg></button></div>
<div class="settings-body"><div class="settings-grid"><label>Execution network<select id="network"><option value="arc-testnet">Arc Testnet · real testnet transactions</option><option value="fake">Offline · simulated ledger</option></select></label><label>Purchasing agent<select id="agent"><option value="grok">Grok</option><option value="grok-careful">Grok · careful prompt</option><option value="naive">Scripted · deterministic</option></select></label></div><div id="readiness" class="readiness"></div><div class="scenario-select-heading"><h3>Scenarios</h3><div><button type="button" class="text-button" id="preset">Focused demo</button><button type="button" class="text-button" id="select-all">Select all</button></div></div><div id="scenario-options"></div></div>
<div class="dialog-footer"><p>Guarded first, then unguarded. Each pass is a separate execution.</p><button type="submit" class="button primary">Save configuration<span class="arrow" aria-hidden="true"><svg><use href="#i-arrow"/></svg><svg><use href="#i-arrow"/></svg></span></button></div></form></dialog>
<div class="sr-only" id="announcer" aria-live="polite" aria-atomic="true"></div>
</body></html>`;
}
