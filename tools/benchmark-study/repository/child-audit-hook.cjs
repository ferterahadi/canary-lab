const fs = require('node:fs');
const path = require('node:path');

// This command runs only as a vetted native hook. Its output lives outside the
// agent's writable/readable attempt, so a model cannot manufacture its receipts.
try {
  const [output, expectedCwd] = process.argv.slice(2);
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (fs.realpathSync(event.cwd) !== fs.realpathSync(expectedCwd)) throw new Error('Unexpected hook working directory');
  const record = { recordedAt: new Date().toISOString(), ...Object.fromEntries([
    'session_id', 'agent_id', 'turn_id', 'hook_event_name', 'tool_name', 'tool_use_id', 'model', 'cwd', 'tool_input', 'tool_response',
  ].filter((key) => event[key] !== undefined).map((key) => [key, event[key]])) };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.appendFileSync(output, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (event.hook_event_name === 'PreToolUse' && typeof event.tool_input?.message === 'string' && event.tool_input.message.startsWith('gAAAA')) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Child message is encrypted at the audit boundary; stop this campaign instead of delegating unaudited context.' } }));
  }
} catch (error) {
  process.stderr.write(`Child-context audit failed: ${String(error)}\n`);
  process.exitCode = 2;
}
