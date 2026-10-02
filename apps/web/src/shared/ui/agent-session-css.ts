export const TIMELINE_CSS = `
/* ── Session divider ─────────────────────────────────────────────────────
   Where one session starts: a filled band, status mark, the session's name,
   who ran it beside the name, and its status at the right edge. Opaque, so a
   lone session's divider can pin over the rows scrolling beneath it. */
.agentts-divrow{list-style:none;position:relative;z-index:2}
.agentts-divrow+.agentts-divrow,.agentts-row+.agentts-divrow,.agentts-notice+.agentts-divrow{margin-top:6px}
.agentts-divider{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 12px;border-block:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-elevated) 72%,var(--bg-base));font-size:10px}
.agentts-divider[data-sticky="true"]{position:sticky;top:0}
.agentts-divrow:first-child>.agentts-divider{border-top-color:transparent}
.agentts-divmark{flex:none;display:grid;place-items:center;width:14px;height:14px;border-radius:50%;border:1.5px solid currentColor;color:var(--text-muted)}
.agentts-divmark svg{width:8px;height:8px}
.agentts-divmark[data-tone="success"]{color:var(--success)}
.agentts-divmark[data-tone="danger"]{color:var(--danger)}
.agentts-divmark.agentts-statusdot{width:7px;height:7px;margin:0 3.5px;border:0}
.agentts-statusdot{border-radius:50%;background:var(--text-muted);flex:none}
.agentts-statusdot[data-live="true"]{background:var(--running);box-shadow:0 0 7px color-mix(in srgb,var(--running) 65%,transparent);animation:agentts-pulse 1.8s ease-in-out infinite}
/* The name is the one thing that differs between two dividers in a stack, so
   it is the one item allowed to read as primary. */
.agentts-divlabel{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:650;color:var(--text-primary)}
/* Provenance is a footnote: one muted mono cluster, separators supplied by the
   layout so a missing item leaves no orphan dot. */
.agentts-provenance{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap;font-family:var(--font-mono);font-size:9.5px;color:var(--text-muted)}
.agentts-provenance>*+*::before{content:'·';margin-right:6px;opacity:.55}
.agentts-divnote{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-muted)}
.agentts-agent{font-family:var(--font-sans);font-weight:600;text-transform:uppercase;letter-spacing:.07em;font-size:9px}
.agentts-count{font-variant-numeric:tabular-nums}
.agentts-divspace{flex:1 1 auto;min-width:4px}
.agentts-divchip{flex:none;display:inline-flex;align-items:center;min-height:18px;padding:1px 7px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--text-muted) 5%,transparent);color:var(--text-muted);font-family:var(--font-mono);font-size:9.5px;font-variant-numeric:tabular-nums;line-height:1;white-space:nowrap}
.agentts-divchip[data-tone="live"]{border-color:color-mix(in srgb,var(--running) 32%,var(--border-default));background:color-mix(in srgb,var(--running) 8%,transparent);color:var(--running)}
.agentts-divchip[data-tone="success"]{border-color:color-mix(in srgb,var(--success) 30%,var(--border-default));color:var(--success)}
.agentts-divchip[data-tone="danger"]{border-color:color-mix(in srgb,var(--danger) 32%,var(--border-default));background:color-mix(in srgb,var(--danger) 7%,transparent);color:var(--danger)}
.agentts-extaction{flex:none;border:0;background:none;padding:0;color:var(--accent);cursor:pointer;font-family:var(--font-sans);font-size:10.5px;font-weight:500;text-decoration:none;white-space:nowrap}
.agentts-extaction:hover,.agentts-extaction:focus-visible{color:var(--text-primary);text-decoration:underline;outline:none}
.agentts-extaction:disabled{cursor:default;opacity:.55;text-decoration:none}
.agentts-exterror{color:var(--danger);font-size:10.5px;line-height:1.4}
.agentts-date{list-style:none;padding:10px 12px 4px;color:var(--text-muted);font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}

/* ── One row shape ───────────────────────────────────────────────────────
   icon · kind · verb · summary · time · chevron, one line tall for every
   entry. A thin rail in the left gutter ties a session's rows together. */
.agentts-rail{margin:0;padding:0 0 8px;list-style:none}
.agentts-row{position:relative;list-style:none;padding:0 4px;animation:agentts-in .22s cubic-bezier(.22,1,.36,1) both}
/* The rail runs through the icon column; each icon's base-coloured disc
   interrupts it, so the line reads as the thread joining the marks. */
.agentts-row::before{content:'';position:absolute;left:20.5px;top:0;bottom:0;width:1px;background:var(--border-default);opacity:.8}
.agentts-divrow+.agentts-row{padding-top:4px}
.agentts-divrow+.agentts-row::before{top:4px}
.agentts-log{display:grid;grid-template-columns:16px 52px 92px minmax(0,1fr) auto 12px;align-items:center;column-gap:8px;width:100%;min-height:26px;margin:1px 0;padding:3px 8px;border:1px solid transparent;border-radius:var(--radius-sm);background:none;color:var(--text-secondary);cursor:pointer;text-align:left;font-size:12px;transition:background .12s ease,border-color .12s ease}
.agentts-log:hover{background:color-mix(in srgb,var(--bg-elevated) 80%,transparent)}
.agentts-log[data-whole="true"]{cursor:default}
.agentts-log[data-whole="true"]:hover{background:none}
.agentts-log[data-whole="true"] .agentts-logsum{white-space:normal;overflow-wrap:anywhere}
.agentts-log:focus-visible{outline:none;border-color:color-mix(in srgb,var(--accent) 55%,var(--border-default))}
.agentts-log[data-selected="true"]{border-color:color-mix(in srgb,var(--accent) 60%,var(--border-default));background:color-mix(in srgb,var(--accent) 15%,transparent)}
.agentts-log[data-selected="true"] .agentts-logsum{color:var(--text-primary)}
.agentts-logicon{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--bg-base)}
.agentts-logicon svg{width:11px;height:11px}
.agentts-logkind{font-family:var(--font-mono);font-size:8.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.agentts-row[data-kind="prompt"] .agentts-logkind{color:var(--boot)}
.agentts-logverb{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:11.5px;font-weight:600;color:var(--text-primary)}
.agentts-log[data-danger="true"] .agentts-logverb{color:var(--danger)}
.agentts-logsum{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)}
.agentts-time{color:var(--text-muted);font-family:var(--font-mono);font-size:9px;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:.01em;white-space:nowrap}
.agentts-chev{color:var(--text-muted);opacity:.7}
.agentts-log:hover .agentts-chev,.agentts-log[data-selected="true"] .agentts-chev{opacity:1}
.agentts-notice{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 12px;list-style:none;font-size:11.5px}
.agentts-noticetext{color:var(--text-secondary)}
.agentts-notice .agentts-plain{flex-basis:100%}
.agentts-morebtn{background:none;border:none;cursor:pointer;color:var(--accent);font-size:11px;padding:0;font-weight:500}

/* ── Modal body ──────────────────────────────────────────────────────────── */
.agentts-modalmeta{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0;padding:8px 16px 10px;border-bottom:1px solid var(--border-default)}
.agentts-metafact{display:flex;flex-direction:column;gap:2px;min-width:0}
.agentts-metafact dt{font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.agentts-metafact dd{margin:0;max-width:52ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary)}
.agentts-pairlink{border:0;background:none;padding:0;color:var(--accent);cursor:pointer;font:inherit}
.agentts-pairlink:hover,.agentts-pairlink:focus-visible{text-decoration:underline;outline:none}
.agentts-modalbody{display:flex;flex-direction:column;gap:16px;padding:16px 18px 20px}
.agentts-band{display:flex;flex-direction:column;gap:8px;min-width:0}
.agentts-band+.agentts-band{padding-top:14px;border-top:1px solid var(--border-default)}
.agentts-bandtitle{margin:0;font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.agentts-prose{color:var(--text-primary);font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0}
/* Raw text shown for the one moment the lazily-loaded markdown parser is still
   arriving — same face and measure as the prose it becomes, so nothing jumps. */
.agentts-mdfallback{margin:0;font:inherit;color:inherit;white-space:pre-wrap;word-break:break-word}
.agentts-thinkbody{color:var(--text-secondary);font-style:italic;border-left:2px solid var(--border-default);padding-left:12px}
.agentts-thinkbody .agentts-prose{color:inherit}
.agentts-plain{margin:0;padding:10px 12px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-base);font-family:var(--font-mono);font-size:11.5px;line-height:1.6;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word}
/* One grid across every line, so the gutter takes the widest number once and a
   wrapped line hangs under its text rather than under its number. */
.agentts-code{display:grid;grid-template-columns:max-content minmax(0,1fr);padding:10px 0;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-base);font-family:var(--font-mono);font-size:11.5px;line-height:1.65;color:var(--text-secondary);overflow-x:auto}
.agentts-codeline{display:contents}
.agentts-ln{padding:0 12px 0 14px;border-right:1px solid var(--border-default);color:var(--text-muted);opacity:.75;text-align:right;font-variant-numeric:tabular-nums;user-select:none}
.agentts-lc{padding:0 14px;white-space:pre-wrap;word-break:break-word}
.agentts-codeline:hover>*{background:color-mix(in srgb,var(--bg-elevated) 70%,transparent)}
.agentts-extdetail{display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.agentts-extnote{margin:0;color:var(--text-muted);font-size:12px;line-height:1.55}
.agentts-nestrail{padding:0}
.agentts-nestrail .agentts-row{padding:0}
.agentts-nestrail .agentts-row::before{left:16.5px}
.agentts-md{white-space:normal}
.agentts-md>*:first-child{margin-top:0}
.agentts-md>*:last-child{margin-bottom:0}
.agentts-md p{margin:0 0 8px}
.agentts-md h1,.agentts-md h2,.agentts-md h3,.agentts-md h4,.agentts-md h5,.agentts-md h6{margin:14px 0 6px;font-weight:650;line-height:1.3;color:var(--text-primary)}
.agentts-md h1{font-size:15px}
.agentts-md h2{font-size:14px}
.agentts-md h3{font-size:13px}
.agentts-md h4,.agentts-md h5,.agentts-md h6{font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-secondary)}
.agentts-md ul,.agentts-md ol{margin:0 0 8px;padding-left:20px}
.agentts-md ul{list-style:disc}
.agentts-md ol{list-style:decimal}
.agentts-md li::marker{color:var(--text-muted)}
.agentts-md li{margin:2px 0}
.agentts-md li>ul,.agentts-md li>ol{margin:2px 0}
.agentts-md a{color:var(--accent);text-decoration:none}
.agentts-md a:hover{text-decoration:underline}
.agentts-md code{font-family:var(--font-mono);font-size:.88em;background:color-mix(in srgb,var(--bg-elevated) 70%,transparent);border:1px solid var(--border-default);border-radius:var(--radius-sm,4px);padding:1px 4px}
.agentts-md pre{margin:0 0 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-base);padding:9px 12px;overflow:auto;max-height:300px}
.agentts-md pre code{background:none;border:none;padding:0;font-size:11px;line-height:1.55}
.agentts-md blockquote{margin:0 0 8px;border-left:2px solid var(--border-default);padding-left:11px;color:var(--text-secondary)}
.agentts-md hr{border:none;border-top:1px solid var(--border-default);margin:12px 0}
.agentts-md table{border-collapse:collapse;margin:0 0 8px;font-size:12px;display:block;overflow-x:auto;max-width:100%}
.agentts-md th,.agentts-md td{border:1px solid var(--border-default);padding:5px 9px;text-align:left;vertical-align:top}
.agentts-md th{background:color-mix(in srgb,var(--bg-elevated) 60%,transparent);font-weight:600;color:var(--text-primary)}
.agentts-md img{max-width:100%}
.agentts-working{position:relative;display:flex;align-items:center;gap:7px;min-height:17px;padding:6px 0 0 38px;color:var(--running);list-style:none}
/* The settled rail's connector fades to 25% at its bottom edge, so without a
   stub of its own the live tip reads as a stray dot BELOW the timeline rather
   than its next step. This picks the line back up and warms it to the running
   hue — the tip of the rail is the part still moving. */
.agentts-working::before{content:'';position:absolute;left:20.25px;top:0;width:1.5px;height:10px;border-radius:2px;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--running) 60%,transparent))}
/* Same 14px geometry as a settled .agentts-node: the pending step is the next
   row of the same rail, not a different species of marker. */
.agentts-worknode{position:absolute;left:14px;top:7px;box-sizing:border-box;width:14px;height:14px;border:1.5px solid color-mix(in srgb,var(--running) 40%,var(--border-default));border-radius:50%;background:var(--bg-base);box-shadow:0 0 0 3px color-mix(in srgb,var(--running) 7%,transparent);z-index:1}
.agentts-worknode::after{content:'';position:absolute;inset:-1.5px;border-radius:50%;background:conic-gradient(from 0deg,transparent 38%,var(--running) 97%,transparent);-webkit-mask:radial-gradient(closest-side,transparent 71%,#000 73%);mask:radial-gradient(closest-side,transparent 71%,#000 73%);animation:agentts-sweep 1.5s linear infinite}
/* A long tool name ("Running mcp__canary_lab__get_flight") truncates rather
   than pushing the clock out of the row — the elapsed figure is the part that
   must stay readable. */
.agentts-worklabel{min-width:0;overflow:hidden;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--running);white-space:nowrap;text-overflow:ellipsis}
.agentts-worktime{flex:none;font-family:var(--font-mono);font-size:8.5px;line-height:1;color:var(--text-muted);font-variant-numeric:tabular-nums;letter-spacing:.01em;white-space:nowrap}
.agentts-pixels{flex:none;display:inline-flex;align-items:center;gap:3.5px;margin-left:-1px}
.agentts-pixels span{width:3.5px;height:3.5px;border-radius:50%;background:var(--running);animation:agentts-pixels 1.4s cubic-bezier(.4,0,.6,1) infinite}
.agentts-pixels span:nth-child(2){animation-delay:.18s}
.agentts-pixels span:nth-child(3){animation-delay:.36s}
@keyframes agentts-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes agentts-pulse{0%,100%{opacity:.65}50%{opacity:1}}
@keyframes agentts-pixels{0%,100%{opacity:.22;transform:translateY(.5px)}50%{opacity:1;transform:translateY(-.5px)}}
@keyframes agentts-sweep{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){
.agentts-row,.agentts-statusdot[data-live="true"],.agentts-pixels span,.agentts-worknode::after{animation:none}
/* Motion can't carry "still working" here, so the shapes state it while still:
   a filled core in the node and three dots at legible opacity. The elapsed
   clock keeps ticking either way — that's the signal that never freezes. */
.agentts-worknode::after{inset:3.5px;background:var(--running);-webkit-mask:none;mask:none}
.agentts-pixels span{opacity:.42}
.agentts-pixels span:first-child{opacity:.8}
}
@media (max-width:520px){
.agentts-log{grid-template-columns:16px 72px minmax(0,1fr) auto 12px}
.agentts-logkind{display:none}
.agentts-provenance{display:none}
}
`
