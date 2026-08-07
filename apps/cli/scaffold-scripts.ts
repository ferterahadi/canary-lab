// The scaffold's package.json scripts have two writers: `canary-lab init`
// creates them, and `canary-lab upgrade` repairs the postinstall hook on every
// install. They read the same constant so the two can never drift — an earlier
// split let `upgrade` quietly reset a hook `init` had just written.
//
// `postinstall` is the whole setup: sync the workspace, then make sure the
// browser the suites run in is present. `install-browsers` never exits
// non-zero, so a failed download leaves the install intact.
export const SCAFFOLD_POSTINSTALL = 'canary-lab upgrade --silent && canary-lab install-browsers'

export const SCAFFOLD_SCRIPTS = {
  postinstall: SCAFFOLD_POSTINSTALL,
  upgrade: 'canary-lab upgrade',
  'install:browsers': 'canary-lab install-browsers',
}
