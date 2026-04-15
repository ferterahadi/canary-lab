import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import type { EnvSetsConfig, BackupRecord } from './types.js';
import { getFeaturesDir, getProjectRoot } from '../runtime/project-root';


function resolveVars(str: string, appRoots: Record<string, string>): string {
  return str.replace(/\$([A-Z_]+)/g, (_, key) => appRoots[key] ?? `$${key}`);
}

function getEnvSetsDir(featureName: string): string {
  if (path.isAbsolute(featureName)) {
    return path.join(featureName, 'envsets');
  }
  return path.join(getFeaturesDir(), featureName, 'envsets');
}

function loadConfig(featureName: string): EnvSetsConfig {
  const envSetsDir = getEnvSetsDir(featureName);
  const configPath = path.join(envSetsDir, 'envsets.config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing envsets config for "${featureName}" at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as EnvSetsConfig;
  config.appRoots = {
    CANARY_LAB_PROJECT_ROOT: getProjectRoot(),
    ...config.appRoots,
  };
  return config;
}

function listEnvSets(envSetsDir: string): string[] {
  return fs
    .readdirSync(envSetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function getSlotFilesInSet(envSetsDir: string, setName: string, slots: string[]): string[] {
  const setDir = path.join(envSetsDir, setName);
  return slots.filter((slot) => fs.existsSync(path.join(setDir, slot)));
}

function backup(
  targets: Array<{ slot: string; targetPath: string }>,
  timestamp: number,
): BackupRecord[] {
  const records: BackupRecord[] = [];
  for (const { targetPath } of targets) {
    if (fs.existsSync(targetPath)) {
      const backupPath = `${targetPath}.bak.${timestamp}`;
      fs.copyFileSync(targetPath, backupPath);
      records.push({ originalPath: targetPath, backupPath });
    }
  }
  return records;
}

function applySet(
  envSetsDir: string,
  setName: string,
  targets: Array<{ slot: string; targetPath: string }>,
) {
  const setDir = path.join(envSetsDir, setName);
  for (const { slot, targetPath } of targets) {
    const sourcePath = path.join(setDir, slot);
    if (fs.existsSync(sourcePath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function restore(records: BackupRecord[]) {
  for (const { originalPath, backupPath } of records) {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, originalPath);
      fs.unlinkSync(backupPath);
    }
  }
}

function revert(
  targets: Array<{ targetPath: string }>,
) {
  let found = 0;
  for (const { targetPath } of targets) {
    const dir = path.dirname(targetPath);
    const base = path.basename(targetPath);
    if (!fs.existsSync(dir)) continue;
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak.`))
      .sort()
      .reverse(); // most recent first
    if (backups.length > 0) {
      const latest = path.join(dir, backups[0]);
      fs.copyFileSync(latest, targetPath);
      for (const b of backups) fs.unlinkSync(path.join(dir, b));
      found++;
      console.log(`  Restored: ${targetPath}`);
    }
  }
  if (found === 0) {
    console.log('  No backup files found.');
  } else {
    console.log(`\nRestored ${found} file(s).`);
  }
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  const featureName = args[0];

  if (!featureName) {
    console.error('Usage: switch.js <feature-name> [--apply <set>|--revert]');
    process.exit(1);
  }

  const envSetsDir = getEnvSetsDir(featureName);
  const config = loadConfig(featureName);
  const feature = config.feature;

  const targets = feature.slots.map((slot) => ({
    slot,
    targetPath: resolveVars(config.slots[slot].target, config.appRoots),
  }));

  // --- REVERT MODE ---
  if (args[1] === '--revert') {
    console.log(`\nReverting env files for "${featureName}"...\n`);
    revert(targets);
    return;
  }

  // --- APPLY MODE (no tests) ---
  if (args[1] === '--apply') {
    const setName = args[2];
    if (!setName) {
      console.error('Usage: switch.js <feature> --apply <set-name>');
      process.exit(1);
    }
    const envSets = listEnvSets(envSetsDir);
    if (!envSets.includes(setName)) {
      console.error(`Unknown set "${setName}". Available: ${envSets.join(', ')}`);
      process.exit(1);
    }
    const timestamp = Date.now();
    console.log(`\nBacking up ${targets.length} file(s)...`);
    backup(targets, timestamp);
    console.log(`Applying "${setName}" env set...`);
    applySet(envSetsDir, setName, targets);
    console.log('Done. Run "npx canary-lab env" to revert originals when needed.\n');
    return;
  }

  // --- INTERACTIVE MODE (prompt + run tests) ---
  const envSets = listEnvSets(envSetsDir);
  if (envSets.length === 0) {
    console.error(`No env sets found in ${envSetsDir}`);
    process.exit(1);
  }

  console.log(`\nWhich env set for ${featureName}?\n`);
  envSets.forEach((setName, i) => {
    const presentFiles = getSlotFilesInSet(envSetsDir, setName, feature.slots);
    console.log(`  ${i + 1}) ${setName.padEnd(12)} — ${presentFiles.length} file(s) (${presentFiles.join(', ')})`);
  });
  console.log('');

  let chosenSet: string | undefined;
  while (!chosenSet) {
    const answer = await prompt(`Enter number or name [1]: `);
    const trimmed = answer === '' ? '1' : answer;
    const asNumber = parseInt(trimmed, 10);
    if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= envSets.length) {
      chosenSet = envSets[asNumber - 1];
    } else if (envSets.includes(trimmed)) {
      chosenSet = trimmed;
    } else {
      console.log(`  Invalid choice. Enter a number 1-${envSets.length} or a set name.`);
    }
  }

  const timestamp = Date.now();

  console.log(`\nBacking up ${targets.length} file(s)... `);
  const backups = backup(targets, timestamp);
  console.log('done');

  console.log(`Applying "${chosenSet}" env set... `);
  applySet(envSetsDir, chosenSet, targets);
  console.log('done\n');

  let cleanupDone = false;
  function cleanup() {
    if (cleanupDone) return;
    cleanupDone = true;
    process.stdout.write('\nRestoring original files... ');
    restore(backups);
    console.log('done\n');
  }

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const testCwd = resolveVars(feature.testCwd, config.appRoots);
  const [cmd, ...cmdArgs] = feature.testCommand.split(' ');

  console.log(`Running: ${feature.testCommand}`);
  console.log('─'.repeat(45));

  const child = spawn(cmd, cmdArgs, { cwd: testCwd, stdio: 'inherit', shell: true });

  child.on('close', (code) => {
    console.log('─'.repeat(45));
    cleanup();
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`Failed to run test command: ${err.message}`);
    cleanup();
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
