import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const PACKAGE_NAME = 'print-bridge-sdk';
const TAG_PREFIX = 'v';

const args = process.argv.slice(2);
let dryRun = false;
let yes = false;
let skipFetch = false;
let target = null;
let otp = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  switch (arg) {
    case '--':
      break;
    case 'sdk':
    case 'package':
    case 'packages':
    case 'npm':
      target = 'sdk';
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '-y':
    case '--yes':
      yes = true;
      break;
    case '--skip-fetch':
      skipFetch = true;
      break;
    case '--otp':
      otp = args[index + 1];
      index += 1;
      break;
    case '-h':
    case '--help':
      printHelp();
      process.exit(0);
      break;
    default:
      if (arg.startsWith('--otp=')) {
        otp = arg.slice('--otp='.length);
      } else {
        fail(`Unexpected argument: ${arg}`);
      }
  }
}

if (target && target !== 'sdk') {
  fail(`Unknown release target: ${target}`);
}

if (otp === '') {
  fail('--otp requires a value.');
}

const repoRoot = run('git', ['rev-parse', '--show-toplevel']).stdout.trim();
process.chdir(repoRoot);

if (!skipFetch) {
  fetchReleaseTags();
}

await releaseSdk();

async function releaseSdk() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  if (packageJson.name !== PACKAGE_NAME) {
    fail(`Expected package name ${PACKAGE_NAME}, got ${packageJson.name}.`);
  }

  const version = packageJson.version;
  const releaseTag = `${TAG_PREFIX}${version}`;

  if (tagExists(releaseTag)) {
    fail(`Tag ${releaseTag} already exists.`);
  }

  console.log(`Release target: ${PACKAGE_NAME}`);
  console.log(`Current package version: ${version}`);
  console.log(`Release tag: ${releaseTag}`);
  console.log('Checks: CI=true pnpm typecheck && CI=true pnpm lint && CI=true pnpm test && npm pack --dry-run');
  console.log(`Command: npm publish${otp ? ' --otp=******' : ''}`);
  console.log(`Command: git tag ${releaseTag}`);
  console.log(`Command: git push origin ${releaseTag}`);

  if (dryRun) {
    console.log('Dry run only; checks, npm publish, and tag push were not run.');
    return;
  }

  ensureCleanWorktree();
  runWithCi('pnpm', ['typecheck'], { stdio: 'inherit' });
  runWithCi('pnpm', ['lint'], { stdio: 'inherit' });
  runWithCi('pnpm', ['test'], { stdio: 'inherit' });
  run('npm', ['pack', '--dry-run'], { stdio: 'inherit' });

  await confirmOrExit(`Confirm publishing ${PACKAGE_NAME}@${version} and pushing ${releaseTag}? [y/N] `);

  const publishArgs = otp ? ['publish', `--otp=${otp}`] : ['publish'];
  run('npm', publishArgs, { stdio: 'inherit' });
  run('git', ['tag', releaseTag], { stdio: 'inherit' });
  run('git', ['push', 'origin', releaseTag], { stdio: 'inherit' });
  console.log(`Published ${PACKAGE_NAME}@${version} and pushed ${releaseTag}.`);
}

async function confirmOrExit(message) {
  if (yes) return;
  if (!process.stdin.isTTY) {
    fail('Refusing to publish without confirmation in a non-interactive shell. Re-run with --yes if this is intentional.');
  }

  const rl = createInterface({ input, output });
  const answer = await rl.question(message);
  rl.close();

  if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
    console.log('Cancelled.');
    process.exit(0);
  }
}

function ensureCleanWorktree() {
  const status = run('git', ['status', '--porcelain']).stdout.trim();
  if (status) {
    fail(`Working tree is not clean. Commit or stash changes before releasing:\n${status}`);
  }
}

function fetchReleaseTags() {
  run('git', ['fetch', '--quiet', 'origin', `+refs/tags/${TAG_PREFIX}*:refs/tags/${TAG_PREFIX}*`]);
}

function tagExists(tag) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function runWithCi(command, commandArgs, options = {}) {
  return run(command, commandArgs, {
    ...options,
    env: { ...process.env, CI: 'true' },
  });
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });

  if (result.error) {
    fail(`${command} ${commandArgs.join(' ')} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    fail(`${command} ${commandArgs.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
  }

  return result;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: node scripts/release.mjs [sdk] [options]

Release target: print-bridge-sdk.

This script runs the SDK release checks, publishes the npm package, then creates
and pushes a vX.Y.Z git tag. It never commits files.

Options:
  --dry-run             Print the release commands without running checks or publishing
  -y, --yes             Skip the confirmation prompt
  --skip-fetch          Do not fetch release tags before checking
  --otp <code>          Pass a 6-digit npm two-factor code to npm publish
  --otp=<code>          Same as --otp <code>
  -h, --help            Show this help
`);
}
