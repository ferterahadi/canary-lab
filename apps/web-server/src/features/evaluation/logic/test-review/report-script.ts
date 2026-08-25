export const ASSERTION_HTML_SCRIPT = `
/* Theme switch: light / system / dark, persisted per reader. The document
   renders correctly with none of this running — the OS media query already
   picked a palette and every case is expanded in the markup. */
;(() => {
  const KEY = 'canary-evaluation-theme'
  const root = document.documentElement
  const buttons = [...document.querySelectorAll('[data-theme-set]')]
  if (!buttons.length) return
  const read = () => {
    try { return localStorage.getItem(KEY) || 'auto' } catch (err) { return 'auto' }
  }
  const paint = (mode) => {
    if (mode === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', mode)
    for (const button of buttons) {
      button.setAttribute('aria-checked', String(button.dataset.themeSet === mode))
    }
  }
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeSet
      try {
        if (mode === 'auto') localStorage.removeItem(KEY)
        else localStorage.setItem(KEY, mode)
      } catch (err) { /* storage blocked — the switch still works for this session */ }
      paint(mode)
    })
  }
  paint(read())
})()

/* Expand / collapse. The markup ships expanded so a JS-less reader sees
   everything; on load we fold away the cases that carry no news — passing,
   skipped and never-run — and leave failures open. */
;(() => {
  const cases = [...document.querySelectorAll('.case')]
  if (!cases.length) return
  const setOpen = (node, open) => {
    node.dataset.open = String(open)
    const toggle = node.querySelector('.case-toggle')
    if (toggle) toggle.setAttribute('aria-expanded', String(open))
  }
  for (const node of cases) {
    const noteworthy = node.dataset.status === 'failed' || node.dataset.status === 'interrupted'
    setOpen(node, noteworthy)
    const toggle = node.querySelector('.case-toggle')
    if (toggle) toggle.addEventListener('click', () => setOpen(node, node.dataset.open !== 'true'))
  }
  const all = (open) => { for (const node of cases) setOpen(node, open) }
  document.querySelector('[data-expand-all]')?.addEventListener('click', () => all(true))
  document.querySelector('[data-collapse-all]')?.addEventListener('click', () => all(false))
  // A deep link should land on an open case, however the reader got there.
  const openTarget = () => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (!id) return
    const node = document.getElementById(id)?.closest('.case')
    if (node) setOpen(node, true)
  }
  window.addEventListener('hashchange', openTarget)
  openTarget()
  // Print with everything visible — a folded report prints as a list of titles.
  window.addEventListener('beforeprint', () => all(true))
})()

/* Filter + search. Hides cases, their nav entries and their matrix cells
   together, so the three views never disagree about what is on screen. */
;(() => {
  const cases = [...document.querySelectorAll('.case')]
  const chips = [...document.querySelectorAll('[data-filter]')]
  const search = document.getElementById('case-search')
  const count = document.querySelector('[data-nav-count]')
  const empty = document.querySelector('[data-nav-empty]')
  if (!cases.length) return
  const navItems = new Map()
  for (const item of document.querySelectorAll('[data-nav-item]')) {
    const id = item.querySelector('a')?.dataset.sectionId
    if (id) navItems.set(id, item)
  }
  const cells = new Map()
  for (const cell of document.querySelectorAll('[data-matrix-cell]')) {
    cells.set(decodeURIComponent(cell.getAttribute('href').slice(1)), cell)
  }
  let status = 'all'
  let term = ''
  const apply = () => {
    let shown = 0
    for (const node of cases) {
      const matches = (status === 'all' || node.dataset.status === status)
        && (!term || (node.dataset.search || '').includes(term))
      node.classList.toggle('is-hidden', !matches)
      navItems.get(node.id)?.classList.toggle('is-hidden', !matches)
      cells.get(node.id)?.classList.toggle('is-hidden', !matches)
      if (matches) shown += 1
    }
    // A group whose every child is filtered out is noise, not structure.
    for (const group of document.querySelectorAll('[data-group], [data-nav-group]')) {
      const children = [...group.querySelectorAll('.case, [data-nav-item]')]
      group.classList.toggle('is-hidden', children.length > 0 && children.every((child) => child.classList.contains('is-hidden')))
    }
    if (count) count.textContent = shown + ' of ' + cases.length + ' shown'
    if (empty) empty.hidden = shown !== 0
  }
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      status = chip.dataset.filter === status ? 'all' : chip.dataset.filter
      for (const other of chips) other.setAttribute('aria-pressed', String(other.dataset.filter === status))
      apply()
    })
  }
  search?.addEventListener('input', () => {
    term = search.value.trim().toLowerCase()
    apply()
  })
  apply()
})()

/* Scroll spy: highlights the nav entry for the case in view and mirrors its
   title into the sticky top bar, so the reader always knows where they are. */
;(() => {
  const links = [...document.querySelectorAll('.nav a[data-section-id]')]
  const now = document.querySelector('[data-topbar-now]')
  const sections = links.map((link) => document.getElementById(link.dataset.sectionId)).filter(Boolean)
  if (!links.length || !sections.length || !('IntersectionObserver' in window)) return
  const setActive = (id) => {
    for (const link of links) {
      const active = link.dataset.sectionId === id
      if (active) {
        link.setAttribute('aria-current', 'true')
        if (now) now.textContent = link.querySelector('.nav-label')?.textContent || ''
      } else {
        link.removeAttribute('aria-current')
      }
    }
  }
  const visible = new Set()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    const active = [...visible]
      .map((el) => ({ id: el.id, top: el.getBoundingClientRect().top }))
      .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0]
    if (active) setActive(active.id)
    else if (now && !visible.size && window.scrollY < 200) now.textContent = ''
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 })
  for (const section of sections) observer.observe(section)
  if (location.hash) setActive(decodeURIComponent(location.hash.slice(1)))
})()

/* Back to top. */
;(() => {
  const button = document.querySelector('[data-to-top]')
  if (!button) return
  button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
  const sync = () => button.classList.toggle('is-visible', window.scrollY > 600)
  window.addEventListener('scroll', sync, { passive: true })
  sync()
})()

/* Flow node ↔ source line. Hovering a step in the diagram opens the test code
   and highlights the statement it came from. */
;(() => {
  const clear = (testCase) => {
    testCase.querySelectorAll('.flow-node.is-active, .code-line.is-highlighted').forEach((el) => {
      el.classList.remove(el.classList.contains('flow-node') ? 'is-active' : 'is-highlighted')
    })
  }
  const activate = (node) => {
    const testCase = node.closest('.case')
    if (!testCase) return
    clear(testCase)
    const line = node.getAttribute('data-code-line')
    if (!line) return
    node.classList.add('is-active')
    const details = testCase.querySelector('.test-code-details')
    if (details) details.open = true
    testCase.querySelectorAll('.code-line[data-code-line="' + line.replace(/"/g, '') + '"]').forEach((el) => {
      el.classList.add('is-highlighted')
    })
  }
  document.querySelectorAll('.flow-node[data-code-line]').forEach((node) => {
    node.addEventListener('mouseenter', () => activate(node))
    node.addEventListener('focus', () => activate(node))
    node.addEventListener('mouseleave', () => {
      const testCase = node.closest('.case')
      if (testCase) clear(testCase)
    })
  })
})()`
