import { formatUsdc } from '../constants.js';
import type { Approval } from '../guard/approvals.js';

/** Item names, URLs and addresses come from merchants, so none of it may reach the page as markup. */
const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const REFRESH_SECONDS = 2;
const MAX_SHOWN_LENGTH = 120;
/** Control characters, zero-width characters and text-direction overrides. */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/**
 * The item name and the merchant URL are whatever the agent asked for. They are shown
 * without invisible characters and cut to a sensible length, so a crafted name cannot
 * push the real details out of view or change how the line reads.
 */
const shown = (text: string): string => {
  const plain = text.replace(INVISIBLE, ' ');
  return esc(plain.length > MAX_SHOWN_LENGTH ? `${plain.slice(0, MAX_SHOWN_LENGTH)}…` : plain);
};

const STATUS_WORDS: Record<Approval['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved, not yet paid',
  denied: 'Denied',
  used: 'Approved and paid',
  expired: 'Expired',
};

function approvalCard(approval: Approval, token: string, now: number): string {
  const secondsLeft = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  const action = (verb: 'approve' | 'deny'): string =>
    `/approvals/${encodeURIComponent(approval.id)}/${verb}?token=${encodeURIComponent(token)}`;
  const buttons =
    approval.status === 'pending'
      ? `<div class="actions">
        <form method="post" action="${esc(action('approve'))}"><button class="approve">Approve</button></form>
        <form method="post" action="${esc(action('deny'))}"><button class="deny">Deny</button></form>
        <span class="left">Expires in ${secondsLeft}s</span>
      </div>`
      : '';
  return `<article class="card is-${approval.status}">
      <p class="status">${STATUS_WORDS[approval.status]}</p>
      <p class="amount">${esc(formatUsdc(approval.amount))} USDC</p>
      <dl>
        <div><dt>Resource</dt><dd>${shown(approval.item)}</dd></div>
        <div><dt>From</dt><dd>${shown(approval.merchantUrl)}</dd></div>
        <div><dt>Pays</dt><dd class="mono">${esc(approval.payTo)}</dd></div>
      </dl>
      ${buttons}
    </article>`;
}

const CSS = `
:root{--paper:#EDF1F5;--surface:#FFFFFF;--ink:#132238;--muted:#55657A;--line:#D3DBE5;--go:#0B7A63;--stop:#BF3A29}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:2.5rem 1rem 4rem}
h1{font-size:1.5rem;margin:0}
.lead{color:var(--muted);margin:.5rem 0 1.5rem}
.card{background:var(--surface);border-radius:.75rem;padding:1.25rem;margin-top:1rem;border-left:.375rem solid var(--line)}
.card.is-pending{border-left-color:var(--ink)}
.card.is-approved,.card.is-used{border-left-color:var(--go)}
.card.is-denied,.card.is-expired{border-left-color:var(--stop)}
.status{margin:0;color:var(--muted);font-size:.875rem;font-weight:600}
.amount{margin:.25rem 0 .75rem;font-size:2rem;font-weight:700;letter-spacing:-.02em}
dl{margin:0;display:grid;gap:.25rem}
dl div{display:flex;gap:1rem;border-top:1px solid var(--line);padding-top:.25rem}
dt{color:var(--muted);min-width:5rem}
dd{margin:0;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem}
.actions{display:flex;align-items:center;gap:.75rem;margin-top:1rem}
button{font:inherit;font-weight:600;border:0;border-radius:.5rem;padding:.625rem 1.25rem;color:#fff;cursor:pointer}
.approve{background:var(--go)}
.deny{background:var(--stop)}
button:focus-visible{outline:.1875rem solid var(--ink);outline-offset:.125rem}
.left{color:var(--muted);font-size:.875rem}
.empty{color:var(--muted);margin-top:1rem}
`;

/**
 * The owner's page: every approval request with buttons on the open ones. Oldest first,
 * so a request that arrives while the owner is about to click is added at the bottom and
 * never moves a button that is already on screen.
 */
export function renderOwnerPage(approvals: readonly Approval[], token: string, now: number): string {
  const cards = approvals.map((approval) => approvalCard(approval, token, now));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Approve agent payments</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>Approve agent payments</h1>
  <p class="lead">Your agent wants to make a payment above your approval threshold. Nothing is paid until you approve it here, and the wallet's other limits still apply.</p>
  ${cards.length > 0 ? cards.join('\n  ') : '<p class="empty">Nothing is waiting for approval.</p>'}
</main>
</body>
</html>
`;
}
