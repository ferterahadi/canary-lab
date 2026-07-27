export const TIMELINE_CSS = `
.agentts-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-base) 90%,transparent);backdrop-filter:blur(8px);font-size:11px}
.agentts-statusdot{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 9px color-mix(in srgb,var(--accent) 65%,transparent);flex:none}
.agentts-agent{font-weight:600;color:var(--text-primary);text-transform:uppercase;letter-spacing:.07em;font-size:10.5px}
.agentts-sep{color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;font-size:9.5px}
.agentts-sid{font-family:var(--font-mono);color:var(--text-secondary);font-size:10.5px}
.agentts-dot{color:var(--text-muted);font-size:10.5px}
.agentts-model{font-family:var(--font-mono);color:var(--text-secondary);font-size:10.5px}
.agentts-count{color:var(--text-muted);font-size:10px;font-variant-numeric:tabular-nums}
.agentts-rail{margin:0;padding:14px 18px 18px;list-style:none}
.agentts-row{position:relative;padding:0 0 15px 28px;animation:agentts-in .26s cubic-bezier(.22,1,.36,1) both}
.agentts-row:last-child{padding-bottom:2px}
.agentts-row::before{content:'';position:absolute;left:7px;top:17px;bottom:-1px;width:1.5px;background:linear-gradient(180deg,var(--border-default),color-mix(in srgb,var(--border-default) 25%,transparent));border-radius:2px}
.agentts-row:last-child::before{display:none}
.agentts-node{position:absolute;left:0;top:2px;width:15px;height:15px;border-radius:50%;border:1.5px solid var(--border-default);display:grid;place-items:center;background:var(--bg-base);z-index:1}
.agentts-sysrow{position:relative;margin:0;padding:0 0 13px 28px;list-style:none;animation:agentts-in .26s cubic-bezier(.22,1,.36,1) both}
.agentts-sysrow:last-child{padding-bottom:2px}
.agentts-sysrow::before{content:'';position:absolute;left:7px;top:17px;bottom:-1px;width:1.5px;background:linear-gradient(180deg,var(--border-default),color-mix(in srgb,var(--border-default) 25%,transparent));border-radius:2px}
.agentts-sysrow:last-child::before{display:none}
.agentts-sysnode{position:absolute;left:0;top:2px;width:15px;height:15px;border-radius:4px;border:1.5px solid var(--border-default);display:grid;place-items:center;background:var(--bg-base);color:var(--text-muted);z-index:1}
.agentts-sysnode svg{width:9px;height:9px}
.agentts-sysbody{display:flex;flex-direction:column;gap:2px;min-width:0}
.agentts-sysline{display:flex;align-items:baseline;min-width:0}
.agentts-systag{font-family:var(--font-mono)}
.agentts-systext{font-family:var(--font-mono);font-size:13px;line-height:1.62;color:var(--text-secondary);word-break:break-word;white-space:pre-wrap;min-width:0}
.agentts-sysrepeat{margin-left:6px;color:var(--text-muted)}
.agentts-node svg{width:8.5px;height:8.5px}
.agentts-rowhead{display:flex;align-items:center;gap:8px;min-height:15px}
.agentts-label{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);font-weight:600}
.agentts-prose{color:var(--text-primary);font-size:13px;line-height:1.62;white-space:pre-wrap;word-break:break-word;margin-top:3px}
.agentts-morebtn{margin-top:4px;background:none;border:none;cursor:pointer;color:var(--accent);font-size:11px;padding:0;font-weight:500}
.agentts-tool{margin-top:4px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:color-mix(in srgb,var(--bg-elevated) 55%,transparent);overflow:hidden;transition:border-color .15s ease,background .15s ease}
.agentts-tool:hover{background:color-mix(in srgb,var(--bg-elevated) 85%,transparent)}
.agentts-toolbtn{display:flex;width:100%;align-items:center;gap:9px;padding:7px 11px;background:none;border:none;cursor:pointer;text-align:left;min-width:0}
.agentts-toolname{font-family:var(--font-mono);font-weight:600;font-size:12px;color:var(--text-primary);flex:none}
.agentts-tooltarget{font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.agentts-chev{margin-left:auto;color:var(--text-muted)}
.agentts-pre{margin:0;border-top:1px solid var(--border-default);padding:9px 12px;font-family:var(--font-mono);font-size:11px;line-height:1.55;color:var(--text-secondary);background:var(--bg-base);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
.agentts-sub{border-top:1px solid var(--border-default)}
.agentts-subbtn{display:flex;width:100%;align-items:center;gap:8px;padding:6px 11px;background:none;border:none;cursor:pointer;text-align:left;min-width:0}
.agentts-subbtn:hover{background:color-mix(in srgb,var(--bg-elevated) 70%,transparent)}
.agentts-sublive{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 60%,transparent);flex:none}
.agentts-subtype{flex:none;font-family:var(--font-mono);font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border-default));border-radius:4px;padding:1px 5px}
.agentts-submeta{font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.agentts-nest{margin:0 0 0 15px;padding:8px 12px 4px 12px;list-style:none;border-left:2px solid var(--border-default);background:var(--bg-base)}
.agentts-nestrow{padding-bottom:11px}
.agentts-nestrow::before{left:5px;top:14px}
.agentts-nestrow .agentts-node{width:11px;height:11px;top:3px}
.agentts-nestrow .agentts-node svg{width:6.5px;height:6.5px}
.agentts-nestrow .agentts-prose{font-size:12px}
.agentts-think{margin-top:1px}
.agentts-thinkbtn{display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600;padding:0}
.agentts-thinkbody{margin-top:6px;color:var(--text-muted);font-size:12px;line-height:1.55;font-style:italic;white-space:pre-wrap;border-left:2px solid var(--border-default);padding-left:11px}
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
.agentts-md li{margin:2px 0}
.agentts-md li>ul,.agentts-md li>ol{margin:2px 0}
.agentts-md a{color:var(--accent);text-decoration:none}
.agentts-md a:hover{text-decoration:underline}
.agentts-md code{font-family:var(--font-mono);font-size:.88em;background:color-mix(in srgb,var(--bg-elevated) 70%,transparent);border:1px solid var(--border-default);border-radius:var(--radius-sm,4px);padding:1px 4px}
.agentts-md pre{margin:0 0 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-base);padding:9px 12px;overflow:auto;max-height:300px}
.agentts-md pre code{background:none;border:none;padding:0;font-size:11px;line-height:1.55}
.agentts-md blockquote{margin:0 0 8px;border-left:2px solid var(--border-default);padding-left:11px;color:var(--text-secondary)}
.agentts-md hr{border:none;border-top:1px solid var(--border-default);margin:12px 0}
.agentts-md table{border-collapse:collapse;margin:0 0 8px;font-size:12px;display:block;overflow-x:auto;max-width:100%}
.agentts-md th,.agentts-md td{border:1px solid var(--border-default);padding:5px 9px;text-align:left;vertical-align:top}
.agentts-md th{background:color-mix(in srgb,var(--bg-elevated) 60%,transparent);font-weight:600;color:var(--text-primary)}
.agentts-md img{max-width:100%}
@keyframes agentts-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.agentts-row,.agentts-sysrow{animation:none}}
`
