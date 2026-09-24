import fs from 'fs'
import path from 'path'

// Recursive directory copy that reports failures as ordinary, catchable JS
// errors.
//
// Deliberately NOT `fs.cpSync(src, dst, { recursive: true })`. On Node 22 that
// walks the tree with a native `std::filesystem::directory_iterator`, and when
// it meets a directory it cannot read the C++ `filesystem_error` escapes as an
// uncaught exception — `libc++abi: terminating due to uncaught exception` — so
// the whole process aborts and a surrounding `try`/`catch` never runs. Copying
// through `readdirSync`/`copyFileSync` keeps every failure on the JS side, where
// EACCES is a normal throw a best-effort caller can log and move past.
//
// Symlinks and other non-regular entries are skipped: callers copy artifact and
// template trees, where following a link out of the tree is never wanted.
//
// `renameEntry` maps each entry's on-disk name to the name it takes in the
// target. It exists because a source tree cannot always store the name it wants
// to produce — `canary-lab init` ships `gitignore` and writes `.gitignore`, since
// npm pack strips a real dotfile from the tarball. It applies to directories as
// well as files, so a renamed directory carries its subtree with it.
//
// `skipEntry` is asked about every entry by its path relative to `sourceDir`
// (forward slashes); a directory it declines is not entered, so its whole
// subtree stays out of the target.
export function copyDirRecursive(
  sourceDir: string,
  targetDir: string,
  renameEntry?: (name: string) => string,
  skipEntry?: (relPath: string) => boolean,
): void {
  copyDirInto(sourceDir, targetDir, '', renameEntry, skipEntry)
}

function copyDirInto(
  sourceDir: string,
  targetDir: string,
  relDir: string,
  renameEntry: ((name: string) => string) | undefined,
  skipEntry: ((relPath: string) => boolean) | undefined,
): void {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (skipEntry?.(rel)) continue
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, renameEntry?.(entry.name) ?? entry.name)
    if (entry.isDirectory()) copyDirInto(source, target, rel, renameEntry, skipEntry)
    else if (entry.isFile()) fs.copyFileSync(source, target)
  }
}
