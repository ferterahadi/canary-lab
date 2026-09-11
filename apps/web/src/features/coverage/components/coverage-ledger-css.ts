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
/* ── Empty main (no summary yet) ───────────────────────────────────────────────
   A left-aligned block centred in the column: prose reads badly centred, and three
   numbered steps are a list, not a headline. The steps are hairline-separated NAMED
   bands (the .clcov-band shape), so they read as a sequence of facts rather than one
   paragraph, and every colour is a token so both themes come free. */
.clcov-empty{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:10px;min-height:100%;width:min(560px,100%);margin:0 auto;padding:48px 28px}
.clcov-empty-mark{display:flex;align-items:center;justify-content:center;width:36px;height:36px;margin-bottom:2px;border-radius:var(--radius-lg);border:1px solid var(--border-default);background:var(--bg-surface);color:var(--border-strong)}
.clcov-empty-h{margin:0;font-size:15px;font-weight:600;line-height:1.35;letter-spacing:-.01em;color:var(--text-primary)}
.clcov-empty-p{margin:0;font-size:12.5px;line-height:1.6;color:var(--text-secondary)}
/* The ladder. The visible number is authored and aria-hidden, so a reader gets the
   <ol> semantics and the chip stays decoration. */
.clcov-empty-steps{list-style:none;margin:8px 0 0;padding:12px 0 0;width:100%;display:flex;flex-direction:column;border-top:1px solid var(--border-default)}
.clcov-empty-step{display:flex;align-items:flex-start;gap:11px;padding:10px 0}
.clcov-empty-step+.clcov-empty-step{border-top:1px solid var(--border-default)}
.clcov-empty-step:first-child{padding-top:0}
.clcov-empty-step:last-child{padding-bottom:0}
.clcov-empty-n{flex:none;display:flex;align-items:center;justify-content:center;width:19px;height:19px;margin-top:1px;border-radius:50%;border:1px solid var(--border-default);font-family:var(--font-mono);font-size:10.5px;line-height:1;color:var(--text-muted);font-variant-numeric:tabular-nums}
.clcov-empty-body{min-width:0;display:flex;flex-direction:column;gap:3px}
.clcov-empty-name{font-size:12.5px;font-weight:600;line-height:1.35;color:var(--text-primary)}
.clcov-empty-say{margin:0;font-size:12px;line-height:1.55;color:var(--text-secondary)}
.clcov-empty-act{align-self:flex-start;margin-top:6px;padding:4px 10px;font-size:11.5px}
/* The closing fact sits in the page's mono aside register (.clcov-sub), so it reads
   as small print about the mechanism rather than a fourth step. */
.clcov-empty-foot{margin:14px 0 0;padding-top:12px;width:100%;border-top:1px solid var(--border-default);font-family:var(--font-mono);font-size:10.5px;line-height:1.6;color:var(--text-muted)}

/* Stat bar: a headline block, then two strips. The strips sit beside the headline at
   every usable width — narrowing tightens the headline rather than moving it, so the
   reader's eye keeps finding the numbers in the same place; only a genuinely cramped
   bar (<500px) drops them under it. The bar stays ~90px tall because a strip at rest is
   one eyebrow line over a 4px bar; everything else lives in the strip's hover card. */
.clcov-statwrap{container-type:inline-size}
.clcov-statbar{display:flex;flex-wrap:wrap;align-items:center;gap:14px 28px;padding:14px 16px;border-bottom:1px solid var(--border-default);background:var(--bg-surface)}
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
   they take every pixel the bar has left, so both rulers end on the same edge as the
   header's Close button — the panel reads as one column, not two inset ones. A hairline
   on the left separates them from the headline like an instrument panel. Its inset is
   the bar's own 16px, so the gap between the hairline and the strips matches the gap
   between the strips and the panel's right edge — 28px used to read as a lopsided box. */
.clcov-groups{flex:1 1 380px;min-width:0;display:grid;gap:12px;padding-left:16px;border-left:1px solid var(--border-default)}
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
  .clcov-statbar{gap:14px 18px}
  .clcov-hero{flex:0 1 210px;min-width:180px;gap:10px}
  .clcov-groups{flex:1 1 260px}
}
/* Narrow bar: below this there is no ruler width left to give, so the strips take the
   full width under the headline and the panel hairline becomes a rule above them. */
@container (max-width:500px){
  .clcov-hero{flex:1 1 0;min-width:0}
  .clcov-groups{flex-basis:100%;order:3;padding-left:0;border-left:0;padding-top:14px;border-top:1px solid var(--border-default)}
}
/* The glossary badge and its popover. The badge sits at the card's right edge
   (margin-left:auto above), so the popover hangs to the LEFT of the badge: anchoring it
   left:0 would run its 330px off the panel's right edge, since the strips now reach that
   edge. Width is capped in container units so a narrow panel keeps it inside the bar. */
.clcov-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;border-radius:50%;border:1px solid var(--border-default);color:var(--text-muted);cursor:help;outline:none}
.clcov-info:hover,.clcov-info:focus-visible{color:var(--text-primary);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
.clcov-info-i{font-size:10px;font-weight:600;line-height:1}
.clcov-info-pop{position:absolute;top:calc(100% + 8px);right:0;z-index:10;width:min(330px,80cqw);display:flex;flex-direction:column;gap:6px;padding:12px 13px;border-radius:var(--radius-lg);background:var(--bg-overlay);border:1px solid var(--border-default);box-shadow:var(--shadow-popover);font-size:11.5px;line-height:1.5;color:var(--text-secondary);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .14s,transform .14s,visibility .14s}
.clcov-info:hover .clcov-info-pop,.clcov-info:focus-within .clcov-info-pop,.clcov-info:focus-visible .clcov-info-pop{opacity:1;visibility:visible;transform:translateY(0)}
/* Both ledgers are flat divider rows: transparent, one hairline between rows, the
   hover/active hues from the token system. A row is caret · id · title · one short
   mono fact · one dot at the right edge — the same silhouette in both panes. */
/* Four fixed columns for both ledgers — id, title, facts, dot — so every title starts
   and wraps at the same edge and the segments / tags / dot line up down the pane
   whatever a row claims. The facts column splits again into a requirement cell and a
   path cell, so the tags of every row end on one edge and the paths on another; a row
   that claims more than fits folds to a count rather than borrowing a neighbour's
   width. Titles clamp at two lines (hovering a cut one floats the whole thing). */
.clcov-row{--clcov-facts-w:150px;--clcov-reqs-w:66px;--clcov-path-w:48px;--clcov-id-w:26px;border-bottom:1px solid var(--border-default);transition:opacity .12s,background .12s}
/* A test row sizes two of these differently. Its id is a padded badge, not bare text,
   so it needs a wider cell than a bare R41 — that is what keeps #9 and #10 from moving
   the title between two rows of one pane. Its facts cell, on the other hand, is
   NARROWER than the requirement pane's: one tag plus a count and one path word need
   66+6+48, and the 30px that buys goes to the title. The requirement pane keeps the
   full 150 because its segments are one square per path×variant cell, and a
   variant-heavy requirement fills it. */
.clcov-row--test{--clcov-id-w:38px;--clcov-facts-w:120px}
.clcov-row[data-active='true']{background:var(--bg-selected)}
.clcov-row[data-dimmed='true']{opacity:.4}
/* A requirement jumped-to from a test row: a brief accent ring locates the row. */
.clcov-row[data-focus='true']{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent) 70%,transparent)}
.clcov-rowhead{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px 5px 6px;cursor:pointer;outline:none;transition:background .12s}
.clcov-rowhead:hover{background:var(--bg-hover)}
.clcov-rowhead:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent) 60%,transparent)}
.clcov-caret{flex:none;width:10px;font-size:10px;line-height:1;color:var(--text-muted)}
.clcov-rowid{flex:none;width:var(--clcov-id-w);font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
.clcov-rowtitle{flex:1 1 auto;min-width:0;font-size:12.5px;line-height:1.4;color:var(--text-primary);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.clcov-rownote{margin-left:6px;font-size:10.5px;color:var(--text-muted)}
/* The mono fact strip on a test row: R1 · happy. The requirement id is the jump link.
   Two fixed sub-columns, each right-aligned, so the tags and the paths each keep a
   column of their own — the cell never widens, so a row that claims a lot cannot
   squeeze its own title narrower than its neighbours'. */
.clcov-rowfacts{position:relative;flex:none;width:var(--clcov-facts-w);display:grid;grid-template-columns:var(--clcov-reqs-w) var(--clcov-path-w);align-items:center;gap:0 6px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);white-space:nowrap}
.clcov-rowreqs{min-width:0;display:inline-flex;justify-content:flex-end;align-items:center;gap:5px;overflow:hidden}
.clcov-rowpath{min-width:0;display:inline-flex;justify-content:flex-end;align-items:center;overflow:hidden}
/* What the folded cell is hiding, floated over the row on hover (or on focus, which a
   Tab into one of the tags gives a keyboard user). An overlay, not a wider cell: the
   row keeps its columns while you read, and the ids stay clickable because the strip
   is a child of the cell the pointer is already in. Same surface as the Tooltip so the
   two reveals on a row read as one thing. */
.clcov-facts-pop{position:absolute;top:50%;right:-6px;transform:translateY(-50%);z-index:12;display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:var(--radius-md);background:var(--bg-elevated);border:1px solid var(--border-default);box-shadow:var(--shadow-popover);white-space:nowrap;opacity:0;visibility:hidden;transition:opacity .12s,visibility .12s}
.clcov-rowfacts:hover .clcov-facts-pop,.clcov-rowfacts:focus-within .clcov-facts-pop{opacity:1;visibility:visible}
/* The count the cell folds to. It is a label, not a control — hovering the cell is
   what opens it — so it carries the folded ids as its own tooltip and no pointer. */
.clcov-more{color:var(--text-muted);text-decoration:underline dotted;text-underline-offset:2px}
.clcov-rowfact{display:inline-flex;align-items:center;gap:5px}
.clcov-rowsep{color:var(--border-strong)}
.clcov-reqtag{appearance:none;background:none;border:0;padding:0;font:inherit;color:var(--text-secondary);cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;transition:color .12s}
.clcov-reqtag:hover{color:var(--text-primary)}
.clcov-reqtag:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 55%,transparent)}
.clcov-orphan{color:var(--warning)}
/* Coverage segments: one square per path (or path×variant cell); filled = claimed. */
.clcov-segs{flex:none;width:var(--clcov-facts-w);display:inline-flex;justify-content:flex-end;align-items:center;gap:2px}
/* The one mark, three states — shared by the resting strip, the per-channel grid
   and the band marks. SHAPE separates "nothing claims this" from "a test does";
   HUE separates "a test claims it" (sky — in progress) from "a run passed it"
   (green — evidence). Green is spent only on the second. */
.clcov-seg{flex:none;width:8px;height:8px;border-radius:2px;background:var(--running)}
.clcov-seg[data-seg='off']{background:transparent;box-shadow:inset 0 0 0 1px var(--border-strong)}
.clcov-seg[data-seg='proven']{background:var(--success)}
.clcov-segn{margin-left:5px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);font-variant-numeric:tabular-nums}
/* The one dot at the right edge (proof health / test strength). Always laid out so
   titles and facts align across rows; transparent when there is nothing to say. */
.clcov-alert{flex:none;width:6px;height:6px;border-radius:50%;margin-left:4px}
/* The disclosed detail sits slightly deeper than the pane. It used to be indented
   32px to line up under the title, which left a dead column down the left of every
   open row while the prose beside it wrapped early; a 2px rail carries the same
   "this belongs to the row above" and gives the 30px back to reading width. */
.clcov-rowdetail{display:flex;flex-direction:column;padding:9px 14px 12px 12px;border-left:2px solid var(--border-default);background:color-mix(in srgb,var(--bg-base) 55%,var(--bg-surface))}
/* The lead: the requirement's full wording, one step up from the section bodies, so
   what it SAYS is unmistakably the first thing you read. It carries no kicker — the
   row you just opened is its label. */
.clcov-req-text{margin:0;font-size:12.5px;line-height:1.55;color:var(--text-primary)}
/* Everything under the lead is a hairline-separated BAND with a name. Before this the
   wording, the path pills, the proof dates and the two prose blocks sat at one 8px
   gap, so five unrelated things read as one paragraph soup — the pills and the dates
   in particular are unreadable until something says what they are. */
/* Kicker · optional gloss · the section's lever. The kicker is the page's mono
   uppercase register. The gloss earns its place ONLY where the band's vocabulary is
   genuinely opaque (the proof dates plus an Accept lever); glossing a term the reader
   already owns just puts a line of noise between them and the content. */
/* The path chips of a 1-axis requirement. */
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

/* One promise per band: its name and its sentence. Hairline-separated so the
   bands read as a stack of NAMED facts rather than one run-on block. No marks
   here — every square a requirement owns is drawn in the grid below, whichever
   grid that is. */
.clcov-bands{display:flex;flex-direction:column;gap:0;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-default)}
.clcov-band{display:flex;flex-direction:column;gap:3px;padding:7px 0}
.clcov-band+.clcov-band{border-top:1px solid var(--border-default)}
.clcov-band:first-child{padding-top:0}
.clcov-band:last-child{padding-bottom:0}
.clcov-band-name{font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}

/* The coverage table, shared by both readings: channels down with paths across,
   or the declared paths down with one lane of marks.

   ONE grid, not one per line. The head and the rows used to be separate grid
   containers sharing a template whose first track is auto-sized, so each
   resolved that track from its OWN first cell — the kicker in the head, a
   channel name in a row — and the column labels sat a dozen pixels right of the
   marks they name. The head and rows are subgrids of this container, so every
   line resolves the name column once. The column gap lives HERE for the same
   reason: a gap re-declared on a subgrid child would re-open the drift. */
.clcov-grid{display:grid;gap:3px 10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-default)}
.clcov-grid-head,.clcov-grid-row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center}
/* Vertical padding only, here and on the rows: padding on a SUBGRID item insets
   its tracks, so a horizontal inset would slide the labels off their marks —
   the drift the single template was introduced to kill. */
.clcov-grid-head{padding-bottom:4px}
.clcov-grid-kicker{font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}
.clcov-grid-col{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-align:center;white-space:nowrap}
.clcov-grid-row{padding:3px 0}
.clcov-grid-name{font-family:var(--font-mono);font-size:10.5px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clcov-grid-word{font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clcov-grid-row[data-na='true'] .clcov-grid-name{color:var(--text-muted)}
.clcov-cellmark{justify-self:center;width:8px;height:8px;border-radius:2px;background:var(--running)}
.clcov-cellmark[data-seg='off']{background:transparent;box-shadow:inset 0 0 0 1px var(--border-strong)}
.clcov-cellmark[data-seg='proven']{background:var(--success)}
.clcov-cellmark[data-seg='na']{background:transparent;box-shadow:inset 0 0 0 1px var(--border-default);opacity:.6}

/* The conclusion, under the marks it is drawn from. One coloured mark; the words
   stay in the text hues so the hue means "this is the status", not "read me". */
.clcov-verdict{display:block;margin:10px 0 0;padding-top:10px;border-top:1px solid var(--border-default);font-size:11px;line-height:1.5;color:var(--text-muted)}
.clcov-verdict-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle}
.clcov-verdict-label{color:var(--text-primary);font-weight:600}
/* Variant coverage = accordion: a row of path pills (happy 1/4); clicking one
   reveals only that path's variant chips below, so a many-path/variant requirement
   stays compact and you inspect one path's gap at a time. */
/* Active pill: accent-tinted so it clearly owns the tray below it. */
/* Expanded detail: a self-contained tray headed by its path name, so the chips
   unambiguously belong to the pill you opened (not the pill above-left of them). */
/* Happy and unhappy are a PAIR, so they sit side by side wherever the pane holds two
   columns (the reclaimed gutter pays for it) and stack when it doesn't. Each keeps a
   neutral hairline rail rather than a hue: they are two CATEGORIES of behaviour, not
   two statuses, and a green "Happy path" beside a happy 0/2 pill read as covered —
   the opposite of what the pill says. */
/* No gloss under these labels: "happy path" and "unhappy path" are common currency,
   and spelling them out was noise the reader had to scan past to reach the prose. */
.clcov-path-text{margin:2px 0 0;font-size:12px;line-height:1.5;color:var(--text-secondary)}
`
