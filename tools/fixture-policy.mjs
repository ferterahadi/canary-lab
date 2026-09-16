export function isFixturePath(relativePath) {
  return relativePath.split(/[\\/]/).some((part) => part === '__fixtures__' || part === 'fixtures')
}

// A recording may keep absolute-path relationships, but it must use invented
// roots such as /workspace. Personal paths turn a regression into local data.
export function personalFixturePathLines(text) {
  return text.split('\n').flatMap((line, index) => {
    const normalized = line.replaceAll('\\/', '/').replaceAll('\\', '/')
    const personalPath = /(?:^|[\s"'`(=:\[,])(?:file:\/{2,3})?(?:\/(?:Users|home)\/+[^/\s"'`<>]+|[A-Za-z]:\/+[Uu][Ss][Ee][Rr][Ss]\/+[^/\s"'`<>]+|~\/)/
    return personalPath.test(normalized) ? [index + 1] : []
  })
}
