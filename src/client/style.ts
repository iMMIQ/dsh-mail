// SPDX-License-Identifier: LGPL-3.0-or-later
/** Scoped layout using the Plugins page's typography and application theme tokens. */
export const style = `
.dsh-mail { display:grid; gap:20px; min-width:0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; }
.dsh-mail section { display:grid; gap:14px; min-width:0; }
.dsh-mail h3 { margin:0; font-size:14px; font-weight:500; }
.dsh-mail .mail-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.dsh-mail .mail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:16px; }
.dsh-mail .mail-stack { display:grid; gap:14px; min-width:0; }
.dsh-mail .mail-field { min-width:0; }
.dsh-mail .mail-field>div { padding:0; }
.dsh-mail .mail-field input { box-sizing:border-box; min-width:0; }
.dsh-mail .mail-hint { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsh-mail strong { font-weight:500; color:var(--dsw-alias-label-primary); }
.dsh-mail .mail-section { padding:16px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); }
.dsh-mail .mail-section-heading { display:flex; align-items:flex-start; gap:12px; }
.dsh-mail .mail-section-heading h3 { line-height:24px; }
.dsh-mail .mail-number { display:grid; place-items:center; flex:none; width:24px; height:24px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3); }
.dsh-mail .mail-summary { display:grid; gap:6px; }
.dsh-mail .mail-addresses { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 12px; margin:0; }
.dsh-mail .mail-addresses dt { color:var(--dsw-alias-label-secondary); }
.dsh-mail .mail-addresses dd { min-width:0; margin:0; overflow-wrap:anywhere; }
.dsh-mail .mail-example { display:grid; gap:8px; padding:12px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3); }
.dsh-mail .mail-example pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--dsh-font-family-terminal,monospace); font-size:13px; line-height:1.6; }
.dsh-mail .mail-connection-result { display:flex; flex-wrap:wrap; gap:6px 16px; }
.dsh-mail .mail-connection-result p { flex-basis:100%; }
.dsh-mail .mail-control { display:grid; gap:6px; min-width:0; }
.dsh-mail .mail-control>span { font-size:13px; font-weight:500; line-height:1.5; }
.dsh-mail select,.dsh-mail textarea { box-sizing:border-box; width:100%; min-width:0; border:0.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); font:inherit; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3); }
.dsh-mail select { height:34px; padding:0 12px; }
.dsh-mail textarea { min-height:76px; padding:8px 12px; resize:vertical; }
.dsh-mail select:focus-visible,.dsh-mail textarea:focus-visible,.dsh-mail pre:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; }
.dsh-mail summary { cursor:pointer; font-weight:500; }
.dsh-mail details>.mail-stack { padding-top:14px; }
@media(max-width:600px) { .dsh-mail .mail-grid { grid-template-columns:minmax(0,1fr); } }
@media(pointer:coarse) { .dsh-mail input,.dsh-mail select,.dsh-mail textarea { font-size:16px; } }
`
