import { ShikiCode } from '@/shared/ui/TestCodeBlock'
import { TestIdBadge } from '@/shared/ui/TestIdBadge'

// R19 redesign: the dialog's chrome + interaction polish, kept in the operator-
// console token system (no new fonts, no component library). Motion is restrained
// and reduced-motion-safe; meaning carries the colour (cl_ui-design-philosophy).
export const COVERAGE_CSS = `
.clcov-head{position:relative;display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--border-default);background:var(--bg-surface)}
.clcov-head::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--accent) 40%,transparent) 50%,transparent 100%);opacity:.7;transition:background .2s}
.clcov-head[data-generating='true']::after{height:2px;background:linear-gradient(90deg,transparent,var(--running),transparent);background-size:200% 100%;opacity:1;animation:clcov-sheen 1.6s linear infinite}
@keyframes clcov-sheen{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.clcov-head[data-generating='true']::after{animation:none;background:var(--running)}}
.clcov-title{display:flex;flex-direction:column;line-height:1.18;min-width:0}
.clcov-eyebrow{font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.clcov-feature{font-size:13.5px;font-weight:600;color:var(--text-primary);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}
.clcov-close{appearance:none;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 12px;transition:background .12s,color .12s,border-color .12s}
.clcov-close:hover{color:var(--text-primary);background:var(--bg-hover);border-color:var(--border-strong)}
.clcov-statbar{display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px;padding:12px 16px;border-bottom:1px solid var(--border-default);background:var(--bg-surface)}
.clcov-chips{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
/* Strength filter sits over the tests column. The breakdown's flex-grow pushes it to
   the right edge — do NOT use margin-left:auto here (it cancels that grow). A light
   full-height rule separates the two summaries (requirements coverage | test strength),
   echoing the column divider below. */
.clcov-strength{flex:none;align-self:stretch;justify-content:flex-end;padding-left:24px;border-left:1px solid var(--border-default)}
/* Narrow viewport: the strength cluster drops to its own full-width row with a
   TOP divider instead of crushing the gap legend into a vertical stack (R24 —
   the row genuinely needs ~1100px: ring + legend + ratios + 4 strength chips).
   The left rule only makes sense while it sits beside the breakdown. */
@media (max-width:1120px){
  .clcov-strength{flex:1 0 100%;align-self:auto;justify-content:flex-start;padding-left:0;padding-top:14px;border-left:none;border-top:1px solid var(--border-default)}
}
.clcov-chip{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;appearance:none;cursor:pointer;font-size:11.5px;color:var(--text-primary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:999px;padding:4px 11px;transition:background .12s,border-color .12s,opacity .12s}
.clcov-chip:hover{background:var(--bg-hover);border-color:var(--border-strong)}
.clcov-chip[data-empty='true']{opacity:.5}
.clcov-chip[data-on='true']{background:color-mix(in srgb,var(--chip) 14%,var(--bg-surface));border-color:color-mix(in srgb,var(--chip) 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--chip) 30%,transparent) inset}
.clcov-chip-dot{width:7px;height:7px;border-radius:50%;flex:none}
.clcov-chip-n{font-variant-numeric:tabular-nums}
/* Coverage breakdown: a proportional bar + legend-filter + plain-language ratios.
   Makes covered ⊂ mapped ⊂ total legible at a glance — no question needed. */
/* Breakdown grows to fill (pushing the strength cluster to the right edge); the BAR
   is what's capped, not the column — capping the column zeroed its flex-grow when the
   strength cluster used margin-left:auto, collapsing the legend into a wrapped stack. */
.clcov-breakdown{flex:1;min-width:min(300px,100%);display:flex;flex-direction:column;gap:8px}
.clcov-bar{display:flex;height:9px;width:100%;max-width:520px;border-radius:999px;overflow:hidden;background:var(--bg-base);border:1px solid var(--border-default)}
.clcov-bar-seg{height:100%;min-width:3px;transition:flex-grow .35s ease}
.clcov-bar-seg+.clcov-bar-seg{box-shadow:-1px 0 0 color-mix(in srgb,var(--bg-base) 70%,transparent)}
.clcov-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.clcov-legend-item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;appearance:none;cursor:pointer;font-size:11.5px;color:var(--text-secondary);background:transparent;border:1px solid transparent;border-radius:var(--radius-md);padding:3px 8px;transition:background .12s,color .12s,border-color .12s,opacity .12s}
.clcov-legend-item:hover{color:var(--text-primary);background:var(--bg-surface)}
.clcov-legend-item[data-empty='true']{opacity:.4}
.clcov-legend-item[data-on='true']{color:var(--text-primary);background:color-mix(in srgb,var(--seg) 15%,var(--bg-surface));border-color:color-mix(in srgb,var(--seg) 50%,transparent)}
.clcov-legend-dot{width:9px;height:9px;border-radius:3px;flex:none}
.clcov-legend-n{font-variant-numeric:tabular-nums;font-weight:600;color:var(--text-primary)}
.clcov-cap{display:flex;flex-wrap:wrap;align-items:center;gap:9px;font-size:11px;color:var(--text-muted)}
.clcov-cap strong{color:var(--text-secondary);font-variant-numeric:tabular-nums;font-weight:600}
.clcov-cap-sep{color:var(--border-default)}
.clcov-stale{color:var(--warning);cursor:help;border-bottom:1px dotted color-mix(in srgb,var(--warning) 55%,transparent)}
.clcov-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;border-radius:50%;border:1px solid var(--border-default);color:var(--text-muted);cursor:help;outline:none}
.clcov-info:hover,.clcov-info:focus-visible{color:var(--text-primary);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
.clcov-info-i{font-size:10px;font-weight:600;line-height:1}
.clcov-info-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:10;width:330px;display:flex;flex-direction:column;gap:6px;padding:12px 13px;border-radius:var(--radius-lg);background:var(--bg-overlay);border:1px solid var(--border-default);box-shadow:var(--shadow-popover);font-size:11.5px;line-height:1.5;color:var(--text-secondary);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .14s,transform .14s,visibility .14s}
.clcov-info:hover .clcov-info-pop,.clcov-info:focus-within .clcov-info-pop,.clcov-info:focus-visible .clcov-info-pop{opacity:1;visibility:visible;transform:translateY(0)}
/* The card is a query container so its header status chips can collapse to a single
   letter when the card itself (not the whole viewport) is too narrow. */
.clcov-card{container-type:inline-size}
.clcov-card:hover{border-color:color-mix(in srgb,var(--text-muted) 38%,var(--border-default))}
/* A @req tag jumped-to from a test card: a brief accent ring locates the card. */
.clcov-card[data-focus='true']{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 70%,transparent)}
/* Clickable @req tags on a test card — jump to the matching requirement. */
.clcov-reqtag{appearance:none;cursor:pointer;transition:filter .12s}
.clcov-reqtag:hover{filter:brightness(1.18)}
.clcov-reqtag:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
.clcov-skel{display:inline-block;border-radius:var(--radius-sm);background:color-mix(in srgb,var(--text-muted) 16%,var(--bg-base))}
/* One loading language: the sweep is the shared .cl-skeleton animation
   (styles.css) layered over this card's own fill — the ledger used to carry a
   second keyframe set at a different speed, so the app had two competing
   skeleton vocabularies. The shared class brings its own reduced-motion guard. */
/* Click-to-expand cards: a quiet caret leads the header; the row is the hit target. */
.clcov-disclose{cursor:pointer;outline:none;border-radius:var(--radius-md);margin:-2px -4px;padding:2px 4px;transition:background .12s}
.clcov-disclose:hover{background:var(--bg-hover)}
.clcov-disclose:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 60%,transparent)}
.clcov-caret{flex:none;width:10px;font-size:10px;line-height:1;color:var(--text-muted)}
/* Test source disclosure. */
.clcov-source{margin-top:9px;border-top:1px solid var(--border-default);padding-top:9px}
.clcov-source-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.clcov-source-path{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clcov-source-open{margin-left:auto;flex:none;appearance:none;cursor:pointer;font-size:10px;font-weight:500;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:2px 8px;transition:background .12s,color .12s,border-color .12s}
.clcov-source-open:hover{color:var(--text-primary);background:var(--bg-hover);border-color:var(--border-strong)}
/* The shared ShikiCode block frames itself (.shiki-block pre); just cap its height so a long body scrolls in place. */
.clcov-source .shiki-block pre{max-height:360px;overflow:auto}
.clcov-source-note{font-size:11.5px;color:var(--text-muted)}
/* Requirement detail disclosure: kind chip + happy / unhappy paths. */
.clcov-reqdetail{margin-top:9px;border-top:1px solid var(--border-default);padding-top:9px;display:flex;flex-direction:column;gap:8px}
/* Requirement card header: a single inline-flow run. Caret, id badge, title, kind
   and gap chips are all inline boxes, vertical-aligned to the text, so they flow and
   wrap together — the tags read as part of the title and tuck after its last word,
   never reserving a right column or block-stacking below it. */
.clcov-reqhead{display:block;line-height:1.55}
.clcov-reqhead .clcov-caret{display:inline;margin-right:5px}
.clcov-reqid{display:inline-flex;align-items:center;vertical-align:middle;margin-right:7px;font-family:var(--font-mono);font-size:10.5px;font-weight:500;color:var(--text-muted);background:var(--bg-base);border:1px solid var(--border-default);border-radius:var(--radius-sm);padding:1px 5px}
/* Wraps the shared TestIdBadge so it flows inline in the test card's header. */
.clcov-testid{display:inline-block;vertical-align:middle;margin-right:7px}
.clcov-req-title{font-size:13px;color:var(--text-primary);overflow-wrap:anywhere}
.clcov-kind-tag{display:inline-flex;align-items:center;vertical-align:middle;margin-left:6px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);background:var(--bg-base);border:1px solid var(--border-default);border-radius:999px;padding:1px 8px}
/* Status chips collapse to their single-letter form when the card is too narrow for
   the words; the full label stays available via the chip's hover title. */
.clcov-cq-abbr{display:none}
@container (max-width:340px){
  .clcov-cq-full{display:none}
  .clcov-cq-abbr{display:inline}
}
/* Gap status is a chip too (matches the kind chip): border + tint derived from its
   own colour via currentColor, so only the hue is set inline. */
.clcov-gap{display:inline-flex;align-items:center;vertical-align:middle;gap:5px;margin-left:6px;font-size:10px;font-weight:600;white-space:nowrap;border-radius:999px;padding:1px 8px;border:1px solid color-mix(in srgb,currentColor 38%,transparent);background:color-mix(in srgb,currentColor 12%,transparent)}
.clcov-gap-dot{width:6px;height:6px;border-radius:50%;flex:none}
.clcov-req-text{font-size:12px;color:var(--text-secondary);line-height:1.45;margin-top:5px}
/* Variant coverage = accordion: a row of path pills (happy 1/4); clicking one
   reveals only that path's variant chips below, so a many-path/variant requirement
   stays compact and you inspect one path's gap at a time. */
.clcov-vgrid{margin-top:9px;display:flex;flex-direction:column;gap:6px}
.clcov-vpaths{display:flex;flex-wrap:wrap;gap:6px}
.clcov-vpath{display:inline-flex;align-items:center;gap:5px;appearance:none;cursor:pointer;font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);background:var(--bg-base);border:1px solid var(--border-default);border-radius:999px;padding:2px 10px;transition:background .12s,border-color .12s}
.clcov-vpath:hover{border-color:var(--border-strong);background:var(--bg-hover)}
.clcov-vpath:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
/* Active pill: accent-tinted so it clearly owns the tray below it. */
.clcov-vpath[data-on='true']{background:color-mix(in srgb,var(--accent) 13%,var(--bg-surface));border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.clcov-vpath[data-on='true'] .clcov-vpath-name{color:var(--text-primary)}
.clcov-vpath-caret{flex:none;width:7px;font-size:8px;color:var(--text-muted)}
.clcov-vpath[data-on='true'] .clcov-vpath-caret{color:color-mix(in srgb,var(--accent) 80%,var(--text-primary))}
.clcov-vpath-name{color:var(--text-secondary)}
.clcov-vpath-n{font-weight:600;font-variant-numeric:tabular-nums}
/* Expanded detail: a self-contained tray headed by its path name, so the chips
   unambiguously belong to the pill you opened (not the pill above-left of them). */
.clcov-vtray{display:flex;flex-direction:column;gap:7px;background:var(--bg-base);border:1px solid color-mix(in srgb,var(--accent) 22%,var(--border-default));border-radius:var(--radius-md);padding:8px 10px}
.clcov-vtray-head{font-family:var(--font-mono);font-size:10px;color:var(--text-muted)}
.clcov-vtray-path{color:var(--text-primary);font-weight:600}
.clcov-vtray-chips{display:flex;flex-wrap:wrap;gap:6px}
.clcov-vchip{font-family:var(--font-mono);font-size:10px;letter-spacing:.02em;padding:1px 7px;border-radius:var(--radius-sm);border:1px dashed color-mix(in srgb,var(--text-muted) 55%,var(--border-default));color:var(--text-muted)}
.clcov-vchip-on{border:1px solid color-mix(in srgb,var(--success) 40%,var(--border-default));background:color-mix(in srgb,var(--success) 10%,transparent);color:var(--success)}
.clcov-vchip-na{border:1px solid color-mix(in srgb,var(--text-muted) 28%,var(--border-default));background:color-mix(in srgb,var(--text-muted) 6%,transparent);color:var(--text-muted);opacity:.7}
.clcov-path-block{display:flex;flex-direction:column;gap:3px}
.clcov-path-label{align-self:flex-start;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.clcov-path-happy{color:var(--success)}
.clcov-path-unhappy{color:var(--accent)}
.clcov-path-text{margin:0;font-size:12px;line-height:1.5;color:var(--text-secondary)}
`
