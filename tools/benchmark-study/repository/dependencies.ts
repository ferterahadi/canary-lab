import fs from 'node:fs'
import path from 'node:path'
import { sha } from '../files'
import { dependencyFingerprint } from '../prepare'

export function repositoryCacheEntries(cache: string, lockfiles: string[]): string[] {
  const hashes = [...new Set(lockfiles.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/^  resolved "[^"\n]+#([a-f0-9]{40})"$/gm)].map((match) => match[1])))].sort()
  if (!hashes.length) throw new Error('Repository lockfiles contain no pinned dependency archives')
  const names = fs.readdirSync(path.join(cache, 'v6')).sort()
  return [...new Set(hashes.flatMap((hash) => {
    const matching = names.filter((name) => name.endsWith(`-${hash}-integrity`) || name.endsWith(`-${hash}`))
    if (!matching.length) throw new Error(`Pinned dependency is missing from the offline Yarn cache: ${hash}`)
    return matching
  }))].sort()
}

export function repositoryCacheDigest(cache: string, entries: string[]): string {
  return sha(entries.map((name) => {
    if (!/^npm-@?[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid frozen cache entry')
    const entry = path.join(cache, 'v6', name)
    if (!fs.lstatSync(entry).isDirectory() || fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Pinned cache entry is not a directory: ${name}`)
    return `${name}:${dependencyFingerprint(entry)}`
  }).join('\n'))
}
