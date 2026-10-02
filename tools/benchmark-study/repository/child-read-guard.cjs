const fs = require('node:fs');
const path = require('node:path');

// Diagnosis children share the parent's native sandbox, so the sandbox cannot
// keep one child out of another failure's packet. This vetted PreToolUse hook is
// the per-child boundary: a call carrying a subagent identity may only read the
// application tree, never write, delegate, run checks, or reach parent context.
// The handoff already carries the child's own diagnostic, so no packet is needed.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'view_image']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'unified_exec', 'container.exec']);
const INERT_TOOLS = new Set(['SubagentHandback', 'update_plan', 'TodoWrite']);
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'find', 'fd', 'tree', 'git']);
// Their first operand is a pattern or script, not a path.
const PATTERN_FIRST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'sed', 'awk', 'jq']);
const VALUE_FLAGS = new Set(['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-E', '-d', '-D',
  '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--include', '--exclude', '--exclude-dir']);
const HIDDEN = /[$`~]|\beval\b|(^|[\s/])\.\.(?=$|[\s/])/;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// The static directory a glob or path would read from: `app/src/**/*.ts` reads app/src.
function staticPrefix(token) {
  const index = token.search(/[*?[{]/);
  return index < 0 ? token : token.slice(0, index).replace(/[^/]*$/, '') || '.';
}

function words(segment) {
  return (segment.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) || []).map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
}

function shellDecision(command, cwd, app, root) {
  if (HIDDEN.test(command.replace(/'[^']*'/g, "''"))) return 'Shell expansion, home or parent-directory paths are not permitted for a diagnosis child.';
  let current = cwd;
  for (const segment of command.split(/&&|\|\||[;|\n()]/).map((part) => part.trim()).filter(Boolean)) {
    const [name, ...rest] = words(segment.replace(/\d*[<>]+&?\d*/g, ' '));
    if (!name) continue;
    if (name === 'cd' || name === 'pushd') {
      const target = path.resolve(current, rest[0] || root);
      if (!inside(app, target)) return `A diagnosis child may only change directory inside ${app}.`;
      current = target;
      continue;
    }
    const program = path.basename(name);
    let skippedPattern = !PATTERN_FIRST.has(program) || rest.some((word) => ['-e', '-f', '--regexp', '--file'].includes(word.split('=')[0]));
    const paths = [];
    // find's operands end at its first predicate; what follows are name patterns.
    const predicate = rest.findIndex((word) => /^[-(!]/.test(word));
    const operands = program === 'find' && predicate >= 0 ? rest.slice(0, predicate) : rest;
    for (let index = 0; index < operands.length; index++) {
      const word = operands[index];
      if (word.startsWith('-')) { if (VALUE_FLAGS.has(word)) index++; continue; }
      if (!skippedPattern) { skippedPattern = true; continue; }
      const looksLikePath = /[/*?]/.test(word) || word === '.' || fs.existsSync(path.resolve(current, word));
      if (!looksLikePath) continue;
      const resolved = path.resolve(current, staticPrefix(word));
      if (!inside(app, resolved)) return `A diagnosis child may only read inside ${app}; ${word} resolves outside it.`;
      paths.push(resolved);
    }
    const recursiveList = name === 'ls' && rest.some((word) => /^-[A-Za-z]*R/.test(word));
    if ((SEARCHERS.has(program) || recursiveList) && !paths.length && !inside(app, current)) {
      return `Give this search an explicit path inside ${app}.`;
    }
  }
  return null;
}

function decide(event, root) {
  const app = path.join(root, 'app');
  const tool = String(event.tool_name || '');
  const input = event.tool_input || {};
  const cwd = path.resolve(root, typeof input.workdir === 'string' ? input.workdir : event.cwd || root);
  if (INERT_TOOLS.has(tool)) return null;
  if (READ_TOOLS.has(tool)) {
    const target = input.file_path || input.path || (typeof input.pattern === 'string' && path.isAbsolute(input.pattern) ? staticPrefix(input.pattern) : null);
    const resolved = target ? path.resolve(cwd, String(target)) : cwd;
    return inside(app, resolved) ? null : `A diagnosis child may only read inside ${app}; pass a path there.`;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = Array.isArray(input.command) ? input.command.join(' ') : input.command || input.cmd;
    return typeof command === 'string' ? shellDecision(command, cwd, app, root) : 'Unreadable shell input from a diagnosis child.';
  }
  return `A diagnosis child is read-only and may not use ${tool || 'an unnamed tool'}; return the proposed patch to the parent.`;
}

try {
  const [output, root] = process.argv.slice(2);
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  // A call without a subagent identity belongs to the parent, which owns the
  // packets and ledger and may work anywhere its sandbox allows.
  if (event.agent_id) {
    const attempt = fs.realpathSync(root);
    if (!inside(attempt, fs.realpathSync(event.cwd))) throw new Error('Unexpected hook working directory');
    const reason = event.hook_event_name === 'PreToolUse' ? decide(event, attempt) : null;
    const record = { recordedAt: new Date().toISOString(), decision: reason ? 'deny' : 'allow', ...(reason ? { reason } : {}),
      ...Object.fromEntries(['session_id', 'agent_id', 'agent_type', 'hook_event_name', 'tool_name', 'tool_use_id', 'cwd', 'tool_input']
        .filter((key) => event[key] !== undefined).map((key) => [key, event[key]])) };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.appendFileSync(output, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
} catch (error) {
  // Exit 2 blocks the call: an unreadable event must not become an unguarded read.
  process.stderr.write(`Child read guard failed: ${String(error)}\n`);
  process.exitCode = 2;
}
