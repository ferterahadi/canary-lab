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
.clcov-close{appearance:none;cursor:pointer;white-space:nowrap;font-size:12px;font-weight:500;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 12px;transition:background .12s,color .12s,border-color .12s}
.clcov-close:hover{color:var(--text-primary);background:var(--bg-hover);border-color:var(--border-strong)}
/* Stat bar: a headline block, then two strips. The strips sit beside the headline at
   every usable width — narrowing tightens the headline rather than moving it, so the
   reader's eye keeps finding the numbers in the same place; only a genuinely cramped
   bar (<500px) drops them under it. The bar stays ~90px tall because a strip at rest is
   one eyebrow line over a 4px bar; everything else lives in the strip's hover card. */
.clcov-statwrap{container-type:inline-size}
.clcov-statbar{display:flex;flex-wrap:wrap;align-items:center;gap:14px 28px;padding:14px 22px;border-bottom:1px solid var(--border-default);background:var(--bg-surface)}
/* The headline takes a fixed share so a long run id in the sub line wraps inside it
   instead of pushing the groups onto their own line. */
/* The headline is a strip too (hover card, focusable); its flex share is fixed so the
   strips beside it keep a steady width. */
.clcov-hero{display:flex;align-items:center;gap:12px;flex:0 1 280px;min-width:230px}
.clcov-hero.clcov-strip{display:flex}
.clcov-hero-text{min-width:0}
.clcov-hero-alert{display:inline-block;vertical-align:middle;margin-left:7px;cursor:help}
.clcov-pct{font-size:26px;font-weight:500;line-height:1;letter-spacing:-.02em;color:var(--text-primary);font-variant-numeric:tabular-nums}
.clcov-sentence{margin-top:3px;font-size:12.5px;line-height:1.35;color:var(--text-primary)}
/* The headline's card: one mono line of ratios; it wraps at spaces so a long run id
   moves whole to a second line. Wider than the headline so that seldom happens. */
.clcov-sub{font-family:var(--font-mono);font-size:10.5px;line-height:1.5;color:var(--text-muted);font-variant-numeric:tabular-nums;display:block;right:auto;min-width:100%;width:max-content;max-width:min(420px,90cqw)}
.clcov-sub-sep{color:var(--border-strong);margin:0 4px}
.clcov-sub-run{font-family:inherit;font-size:inherit;color:var(--text-secondary);white-space:nowrap}
.clcov-stale{color:var(--warning);cursor:help;border-bottom:1px dotted color-mix(in srgb,var(--warning) 55%,transparent)}
/* The two strips stack, one ruler over the other at the same width so they compare;
   capped so a 2000px screen gets readable rulers, not screen-wide ones. A hairline on
   the left separates them from the headline like an instrument panel. */
.clcov-groups{flex:1 1 380px;min-width:0;max-width:820px;display:grid;gap:12px;padding-left:28px;border-left:1px solid var(--border-default)}
/* A strip is the positioning root for its hover card and is focusable so a keyboard
   user can open the card without filtering. The negative margin + padding give the
   hover zone a little room around the bar without moving anything. */
.clcov-strip{position:relative;display:grid;gap:6px;min-width:0;margin:-4px -8px;padding:4px 8px;border-radius:6px;outline:none}
.clcov-strip:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
/* Eyebrow: the strip's name in the page's mono kicker register, its total at the right edge. */
.clcov-grp-label{display:flex;align-items:center;gap:12px;font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.clcov-grp-name{display:inline-flex;align-items:center;gap:6px;flex:none}
.clcov-grp-label i{font-style:normal;font-family:var(--font-mono);font-size:10.5px;letter-spacing:0;text-transform:none;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto}
/* The active filter, named at rest so the eyebrow never hides it: dot · count · word. */
.clcov-strip-on{display:inline-flex;align-items:center;gap:5px;font-family:inherit;font-size:10.5px;letter-spacing:0;text-transform:none;color:var(--text-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
/* The hover card: an overlay under the bar (never pushes the ledgers), the figures in a
   row, the glossary at its end. Opens on hover or focus-within; closes when the pointer
   leaves the strip. Same surface as the glossary popover so the two read as one family. */
.clcov-card{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:10;display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 18px;padding:10px 12px;border-radius:var(--radius-lg);background:var(--bg-overlay);border:1px solid var(--border-default);box-shadow:var(--shadow-popover);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .14s,transform .14s,visibility .14s}
.clcov-strip:hover .clcov-card,.clcov-strip:focus-within .clcov-card{opacity:1;visibility:visible;transform:translateY(0)}
/* Figures: the number at reading size over its word and dot. The selected state is the
   neutral selected surface — the dot already carries the hue. A lit segment dims the
   other figures (and a lit figure dims the other segments) so bar and words read as one. */
.clcov-fig{display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;appearance:none;cursor:pointer;font:inherit;text-align:left;color:var(--text-secondary);background:transparent;border:0;border-radius:6px;padding:4px 8px 5px 6px;margin:-4px -8px -5px -6px;transition:background .12s,color .12s,opacity .12s}
.clcov-fig:hover{color:var(--text-primary);background:var(--bg-hover)}
.clcov-fig:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
.clcov-fig[data-empty='true']{opacity:.45}
.clcov-fig[data-dim='true']{opacity:.35}
.clcov-fig[data-on='true']{color:var(--text-primary);background:var(--bg-selected)}
.clcov-fig-n{font-size:16px;font-weight:500;line-height:1.1;color:var(--text-primary);font-variant-numeric:tabular-nums}
.clcov-fig-w{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;line-height:1.3;white-space:nowrap}
.clcov-card .clcov-info{margin-left:auto;align-self:center}
/* The ruler: one proportional bar per strip; a 2px gap separates the segments instead
   of a border. Each segment is a button (click = filter); a taller invisible hit area
   would need a wrapper, so the strip's own padding does that job instead. */
.clcov-bar{display:flex;gap:2px;height:4px;width:100%;border-radius:2px;overflow:hidden}
.clcov-bar-seg{height:100%;min-width:3px;appearance:none;border:0;padding:0;cursor:pointer;transition:flex-grow .35s ease,opacity .12s}
.clcov-bar-seg[data-dim='true']{opacity:.3}
.clcov-bar-seg:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--text-primary)}
.clcov-legend-dot{width:6px;height:6px;border-radius:50%;flex:none}
/* Medium bar: the headline STAYS beside the strips — it just gets tighter, so the one
   thing that changes with width is how much ruler you get, not where the numbers live.
   Stacking here used to leave the headline alone on a wide empty line. */
@container (max-width:760px){
  .clcov-statbar{padding:14px 16px;gap:14px 18px}
  .clcov-hero{flex:0 1 210px;min-width:180px;gap:10px}
  .clcov-groups{flex:1 1 260px;padding-left:18px}
}
/* Narrow bar: below this there is no ruler width left to give, so the strips take the
   full width under the headline and the panel hairline becomes a rule above them. */
@container (max-width:500px){
  .clcov-hero{flex:1 1 0;min-width:0}
  .clcov-groups{flex-basis:100%;order:3;max-width:none;padding-left:0;border-left:0;padding-top:14px;border-top:1px solid var(--border-default)}
}
.clcov-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;border-radius:50%;border:1px solid var(--border-default);color:var(--text-muted);cursor:help;outline:none}
.clcov-info:hover,.clcov-info:focus-visible{color:var(--text-primary);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
.clcov-info-i{font-size:10px;font-weight:600;line-height:1}
.clcov-info-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:10;width:min(330px,80cqw);display:flex;flex-direction:column;gap:6px;padding:12px 13px;border-radius:var(--radius-lg);background:var(--bg-overlay);border:1px solid var(--border-default);box-shadow:var(--shadow-popover);font-size:11.5px;line-height:1.5;color:var(--text-secondary);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .14s,transform .14s,visibility .14s}
.clcov-info:hover .clcov-info-pop,.clcov-info:focus-within .clcov-info-pop,.clcov-info:focus-visible .clcov-info-pop{opacity:1;visibility:visible;transform:translateY(0)}
/* Both ledgers are flat divider rows: transparent, one hairline between rows, the
   hover/active hues from the token system. A row is caret · id · title · one short
   mono fact · one dot at the right edge — the same silhouette in both panes. */
/* One fixed facts column (--clcov-facts-w) for both ledgers, so every title wraps at
   the same edge and the segments / tags / dot line up down the pane whatever a row
   claims. Titles clamp at two lines (the full text is the tooltip). */
.clcov-row{--clcov-facts-w:150px;border-bottom:1px solid var(--border-default);transition:opacity .12s,background .12s}
.clcov-row[data-active='true']{background:var(--bg-selected)}
.clcov-row[data-dimmed='true']{opacity:.4}
/* A requirement jumped-to from a test row: a brief accent ring locates the row. */
.clcov-row[data-focus='true']{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent) 70%,transparent)}
.clcov-rowhead{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px 5px 6px;cursor:pointer;outline:none;transition:background .12s}
.clcov-rowhead:hover{background:var(--bg-hover)}
.clcov-rowhead:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent) 60%,transparent)}
.clcov-caret{flex:none;width:10px;font-size:10px;line-height:1;color:var(--text-muted)}
.clcov-rowid{flex:none;min-width:26px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
.clcov-rowtitle{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.4;color:var(--text-primary);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.clcov-rownote{margin-left:6px;font-size:10.5px;color:var(--text-muted)}
/* The mono fact strip on a test row: R1 · happy. The requirement id is the jump link. */
.clcov-rowfacts{flex:none;width:var(--clcov-facts-w);display:inline-flex;justify-content:flex-end;align-items:center;gap:5px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);white-space:nowrap}
/* Unfolded "+N" tags may run past the column; the row lets them, once asked. */
.clcov-rowfacts[data-expanded='true']{width:auto;min-width:var(--clcov-facts-w)}
.clcov-more{text-decoration:none;color:var(--text-muted)}
.clcov-rowfact{display:inline-flex;align-items:center;gap:5px}
.clcov-rowsep{color:var(--border-strong)}
.clcov-reqtag{appearance:none;background:none;border:0;padding:0;font:inherit;color:var(--text-secondary);cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;transition:color .12s}
.clcov-reqtag:hover{color:var(--text-primary)}
.clcov-reqtag:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
.clcov-orphan{color:var(--warning)}
/* Coverage segments: one square per path (or path×variant cell); filled = claimed. */
.clcov-segs{flex:none;width:var(--clcov-facts-w);display:inline-flex;justify-content:flex-end;align-items:center;gap:2px}
.clcov-seg{flex:none;width:8px;height:8px;border-radius:2px;background:var(--success)}
.clcov-seg[data-seg='off']{background:transparent;box-shadow:inset 0 0 0 1px var(--border-strong)}
.clcov-segn{margin-left:5px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
/* The one dot at the right edge (proof health / test strength). Always laid out so
   titles and facts align across rows; transparent when there is nothing to say. */
.clcov-alert{flex:none;width:6px;height:6px;border-radius:50%;margin-left:4px}
/* The disclosed detail sits slightly deeper than the pane, indented under the title. */
.clcov-rowdetail{display:flex;flex-direction:column;gap:8px;padding:8px 12px 12px 32px;background:color-mix(in srgb,var(--bg-base) 55%,var(--bg-surface))}
.clcov-req-text{font-size:11.5px;color:var(--text-secondary);line-height:1.5}
/* A pane-level aside (the orphan count) in the same mono register as the row facts. */
.clcov-note{display:flex;align-items:center;gap:7px;margin-bottom:8px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)}
.clcov-skel{display:inline-block;border-radius:var(--radius-sm);background:color-mix(in srgb,var(--text-muted) 16%,var(--bg-base))}
/* One loading language: the sweep is the shared .cl-skeleton animation
   (styles.css) layered over this row's own fill — the ledger used to carry a
   second keyframe set at a different speed, so the app had two competing
   skeleton vocabularies. The shared class brings its own reduced-motion guard. */
/* Test source disclosure. */
/* The test source detail drops the requirement detail's 32px indent and most of the
   side inset so the code canvas takes the row's width — the wrapped English steps
   get every pixel the pane has. */
.clcov-rowdetail.clcov-source{padding:6px 8px 10px 8px}
/* The shared ShikiCode block frames itself (.shiki-block pre); just cap its height so a long body scrolls in place. */
.clcov-source .shiki-block pre{max-height:360px;overflow:auto}
.clcov-source-note{font-size:11.5px;color:var(--text-muted)}
.clcov-enf{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:10.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
.clcov-enf-item{display:inline-flex;align-items:center;gap:8px}
.clcov-enf-sep{color:var(--border-default)}
.clcov-enf code{font-family:var(--font-mono);font-size:10px;color:var(--text-secondary)}
.clcov-enf-accept{font:inherit;font-size:10.5px;line-height:1.3;padding:1px 8px;border-radius:999px;border:1px solid var(--border-default);background:transparent;color:var(--text-secondary);cursor:pointer;transition:background 120ms,border-color 120ms}
.clcov-enf-accept:hover{background:var(--bg-selected);border-color:var(--text-muted)}
/* Variant coverage = accordion: a row of path pills (happy 1/4); clicking one
   reveals only that path's variant chips below, so a many-path/variant requirement
   stays compact and you inspect one path's gap at a time. */
.clcov-vgrid{display:flex;flex-direction:column;gap:6px}
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
