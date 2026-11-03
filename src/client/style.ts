// SPDX-License-Identifier: LGPL-3.0-or-later
/** Scoped layout using the Plugins page's typography and application theme tokens. */
export const style = `
.dsh-mail { display:grid; gap:20px; min-width:0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; }
.dsh-mail section { display:grid; gap:14px; min-width:0; }
.dsh-mail h3 { margin:0; font-size:14px; font-weight:500; }
.dsh-mail .mail-row { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.dsh-mail .mail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:16px; }
.dsh-mail .mail-stack { display:grid; gap:14px; min-width:0; }
.dsh-mail .mail-hint { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; }
.dsh-mail .mail-control { display:grid; gap:6px; min-width:0; }
.dsh-mail select,.dsh-mail textarea { box-sizing:border-box; width:100%; min-width:0; border:1px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); padding:8px 10px; font:inherit; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-3); }
.dsh-mail textarea { min-height:76px; resize:vertical; }
.dsh-mail select:focus-visible,.dsh-mail textarea:focus-visible { outline:2px solid var(--dsw-alias-link); outline-offset:2px; }
.dsh-mail summary { cursor:pointer; font-weight:500; }
.dsh-mail details>.mail-stack { padding-top:14px; }
.dsh-mail .mail-status { display:grid; gap:4px; padding:12px; border:1px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); overflow-wrap:anywhere; }
@media(max-width:600px) { .dsh-mail .mail-grid { grid-template-columns:minmax(0,1fr); } }
@media(pointer:coarse) { .dsh-mail input,.dsh-mail select,.dsh-mail textarea { font-size:16px; } }
`
