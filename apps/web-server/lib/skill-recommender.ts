import type { SkillRecord } from './skill-loader'

// Pure tokenize / score / rank module for the Add Test wizard. No embeddings
// — we score skills by counting how many unique PRD tokens appear in each
// skill's name + description (case-insensitive substring), with name weighted
// 2× description. Tiebreak by shorter name first.
//
// Floor: if fewer than three matchable tokens hit any skill, return [] —
// the recommender is signalling "nothing relevant", and the UI should let
// the user pick manually.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'with', 'by',
  'and', 'or', 'but', 'if', 'when', 'this', 'that', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'has', 'have',
  'had', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
  'must', 'not', 'as', 'it', 'its', 'from', 'into', 'about',
])

const TOKEN_SPLIT = /[^a-z0-9]+/

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of lowered.split(TOKEN_SPLIT)) {
    if (!piece) continue
    if (piece.length < 2) continue
    if (STOPWORDS.has(piece)) continue
    if (seen.has(piece)) continue
    seen.add(piece)
    out.push(piece)
  }
  return out
}

export interface RecommendationResult {
  skillId: string
  score: number
  matchedTerms: string[]
  reasoning: string
}

export interface RecommendOptions {
  topN?: number
  // Minimum unique tokens that must hit somewhere across the skill catalog
  // before we return any results. Defaults to 3.
  minMatchedTokens?: number
}

interface ScoredSkill {
  skill: SkillRecord
  score: number
  matched: string[]
}

function scoreSkill(skill: SkillRecord, tokens: string[]): ScoredSkill {
  const name = skill.name.toLowerCase()
  const desc = skill.description.toLowerCase()
  const matched: string[] = []
  let score = 0
  for (const token of tokens) {
    const inName = name.includes(token)
    const inDesc = desc.includes(token)
    if (!inName && !inDesc) continue
    matched.push(token)
    score += inName ? 2 : 1
  }
  return { skill, score, matched }
}

export function recommendSkills(
  prdText: string,
  skills: SkillRecord[],
  opts: RecommendOptions = {},
): RecommendationResult[] {
  const topN = opts.topN ?? 5
  const minMatched = opts.minMatchedTokens ?? 3
  const tokens = tokenize(prdText)
  if (tokens.length === 0) return []

  const scored = skills.map((s) => scoreSkill(s, tokens)).filter((s) => s.score > 0)

  // Floor check: count unique PRD tokens that hit ANY skill at all.
  const uniqueHits = new Set<string>()
  for (const s of scored) for (const t of s.matched) uniqueHits.add(t)
  if (uniqueHits.size < minMatched) return []

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.skill.name.length - b.skill.name.length
  })

  return scored.slice(0, topN).map((s) => ({
    skillId: s.skill.id,
    score: s.score,
    matchedTerms: s.matched,
    reasoning: `Matched ${s.matched.length} PRD term${s.matched.length === 1 ? '' : 's'}: ${s.matched.join(', ')}`,
  }))
}
