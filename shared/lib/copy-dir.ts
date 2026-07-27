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
export function copyDirRecursive(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const target = path.join(targetDir, entry.name)
    if (entry.isDirectory()) copyDirRecursive(source, target)
    else if (entry.isFile()) fs.copyFileSync(source, target)
  }
}
