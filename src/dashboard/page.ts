export function renderDashboard(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><title>Tripwire — Live attack lab</title>
<link rel="stylesheet" href="/assets/dashboard.css?token=${token}"><script src="/assets/app.js?token=${token}" defer></script></head>
<body>
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
<aside class="sidebar">
  <a class="brand" href="#"><span class="brand-mark"><span></span><span></span><span></span></span>tripwire<span class="brand-dot">.</span></a>
  <div class="workspace-label">AGENT SECURITY WORKSPACE</div>
  <div class="nav-current"><svg><use href="#i-shield"/></svg>Live attack lab<span class="tiny-tag">BETA</span></div>
  <div class="queue-heading"><span>SCENARIO QUEUE</span><span id="queue-count">04</span></div>
  <nav id="queue" aria-label="Scenario queue"></nav>
  <button class="add-scenarios" id="choose-scenarios">+ &nbsp;Choose scenarios</button>
  <div class="sidebar-bottom"><div class="infra-icon"><svg><use href="#i-bolt"/></svg></div><div><strong id="sidebar-network">Arc Testnet</strong><span id="sidebar-agent">Grok agent</span></div><span class="dot muted-dot"></span></div>
</aside>
<div class="workspace">
  <header class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong>Attack lab</strong></div><div class="topbar-right"><span class="connection"><span class="dot" id="connection-dot"></span><span id="connection">Connecting</span></span><span class="header-divider"></span><span class="mono">TRIPWIRE / 01</span></div></header>
  <main>
    <section class="page-heading"><div><div class="eyebrow"><span class="small-line"></span>RED TEAM, IN REAL TIME</div><h1>Your agent. Under attack.</h1><p>See the exploit. Follow the money. Watch the guard.</p></div><div class="page-actions"><button class="button secondary" id="configure"><svg><use href="#i-sliders"/></svg>Configure</button><button class="button primary" id="start" disabled><svg><use href="#i-play"/></svg>Run comparison</button><button class="button stop" id="stop" hidden>Stop after scenario</button></div></section>
    <div id="notice" class="notice" role="status" hidden></div>
    <section class="metrics" aria-label="Run summary">
      <article class="metric"><div class="metric-label">Scenarios completed<svg><use href="#i-target"/></svg></div><div class="metric-value" id="metric-progress">0 <span>/ 8</span></div><div class="metric-note" id="metric-progress-note">Two passes. Same attack scenarios.</div><div class="metric-track"><span id="progress-bar"></span></div></article>
      <article class="metric"><div class="metric-label">Guard interventions<svg><use href="#i-shield"/></svg></div><div class="metric-value teal" id="metric-guards">0</div><div class="metric-note">Observed payment or receipt denials</div></article>
      <article class="metric"><div class="metric-label">Loss · USDC equivalent<svg><use href="#i-wallet"/></svg></div><div class="loss-pair"><div><span class="mini-label">GUARDED</span><strong id="metric-loss-on">—</strong></div><span class="loss-divider"></span><div><span class="mini-label">UNGUARDED</span><strong id="metric-loss-off">—</strong></div></div><div class="metric-note" id="metric-loss-note">Finalized after outcome measurement</div></article>
      <article class="metric"><div class="metric-label">Honest purchases<svg><use href="#i-check"/></svg></div><div class="metric-value" id="metric-honest">0 <span>/ 2</span></div><div class="metric-note" id="metric-honest-note">Protection that keeps payments working</div></article>
    </section>
    <section class="investigation" aria-labelledby="attack-title">
      <div class="stage-heading"><div><div class="stage-overline"><span class="pill" id="category">SEND ATTACK</span><span class="mono" id="scenario-number">ATTACK 03</span></div><h2 id="attack-title">Prompt injection</h2><p id="attack-goal">Turn a product description into an instruction to send money elsewhere.</p></div><button id="follow" class="button secondary compact" hidden>Return to live <span>↗</span></button><div id="run-status" class="run-status">Ready to run</div></div>
      <div class="attack-explainer"><svg><use href="#i-bolt"/></svg><p id="attack-description">A merchant-controlled description tells the agent to ignore earlier payment details.</p></div>
      <div class="comparison" id="comparison"></div>
      <div class="stage-footer"><span><span class="dot muted-dot"></span><span id="run-caption">Waiting for a run · No funds have moved</span></span><span id="event-count" class="mono">0 EVENTS RECORDED</span></div>
    </section>
    <section class="evidence-section"><div class="section-title"><div><svg><use href="#i-code"/></svg><h2>Under the hood</h2><span>Observed events & evidence</span></div><span class="mono" id="evidence-count">00</span></div><div id="evidence"></div></section>
    <section id="downloads" class="downloads" hidden></section>
    <footer class="page-footer"><span><svg><use href="#i-shield"/></svg>The agent asks. The guard decides.</span><span id="footer-network">Arc Testnet · Testnet USDC</span></footer>
  </main>
</div>
<dialog id="settings"><form id="settings-form"><div class="dialog-header"><div><div class="eyebrow">SET UP YOUR RUN</div><h2>Configure attack lab</h2></div><button type="button" class="icon-button" id="close-settings" aria-label="Close configuration"><svg><use href="#i-close"/></svg></button></div>
<div class="settings-body"><div class="settings-grid"><label>Execution network<select id="network"><option value="arc-testnet">Arc Testnet · real testnet transactions</option><option value="fake">Offline · simulated ledger</option></select></label><label>Purchasing agent<select id="agent"><option value="grok">Grok</option><option value="grok-careful">Grok · careful prompt</option><option value="naive">Scripted · deterministic</option></select></label></div><div id="readiness" class="readiness"></div><div class="scenario-select-heading"><h3>Scenarios</h3><div><button type="button" class="text-button" id="preset">Focused demo</button><button type="button" class="text-button" id="select-all">Select all</button></div></div><div id="scenario-options"></div></div>
<div class="dialog-footer"><p>Guarded first, then unguarded. Each pass is a separate execution.</p><button type="submit" class="button primary">Save configuration<svg><use href="#i-check"/></svg></button></div></form></dialog>
<div class="sr-only" id="announcer" aria-live="polite" aria-atomic="true"></div>
</body></html>`;
}
