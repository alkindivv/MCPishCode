/* Package E2E failure modes, declared before the gate:
 * - A frontend-only dependency/build or hidden UI bundle ships in the tarball.
 * - Source works but packaged entrypoint/config/runtime files are missing.
 * - Packaged OAuth/MCP tool responses violate the text-native contract.
 * - Test accidentally uses live credentials/state or leaves temp state behind.
 * Repeat: pnpm build && node scripts/e2e-package.mjs
 * Shared node_modules uses the lockfile-installed graph; no install hooks run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.E2E_PACKAGE_ARTIFACT_PATH ?? join(root, 'artifacts/package-e2e.json'));
const temporary = mkdtempSync(join(tmpdir(), 'mcpishcode-package-e2e-'));
const report = { suite: 'mcpishcode-packaged-text-only', checks: {}, results: [] };
const forbidden = ['@modelcontextprotocol/ext-apps', '@pierre/diffs', '@pierre/theme', 'react', 'react-dom', 'vite', '@vitejs/plugin-react', '@types/react', '@types/react-dom', 'playwright'];
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]))[0];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  for (const name of forbidden) assert(!Object.hasOwn(dependencies, name), `frontend-only dependency remains: ${name}`);
  report.checks.frontendDependenciesAbsent = true;
  assert(!/vite|build:app|build:web/.test(JSON.stringify(manifest.scripts)), 'frontend build script remains');
  const badFiles = packed.files.map(item => item.path).filter(path => /(^|\/)(ui|web|qa)(\/|$)|\.(html|css|tsx)$|review-checkpoints|workspace-web|workspace-activity-(journal|store)/.test(path));
  assert.deepEqual(badFiles, [], 'frontend/review/journal runtime files shipped');
  report.checks.frontendFilesAbsent = true;
  const tarball = join(temporary, packed.filename);
  const bytes = readFileSync(tarball);
  report.package = { name: packed.name, version: packed.version, files: packed.files.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const artifactTarball = join(dirname(output), packed.filename);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(artifactTarball, bytes);
  run('tar', ['-xzf', tarball, '-C', temporary]);
  const unpacked = join(temporary, 'package');
  symlinkSync(join(root, 'node_modules'), join(unpacked, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const version = run(process.execPath, [join(unpacked, 'dist/cli.js'), '--version']).trim();
  assert(version.includes(manifest.version), 'packaged CLI version disagrees');
  report.checks.packagedCliVersion = true;
  report.cliVersion = version;
  const runtimeArtifact = join(dirname(output), 'packaged-http-e2e.json');
  run(process.execPath, [join(root, 'scripts/e2e-text-only.mjs')], { env: { ...process.env, E2E_MODULE_ROOT: unpacked, E2E_ARTIFACT_PATH: runtimeArtifact } });
  report.results = JSON.parse(readFileSync(runtimeArtifact, 'utf8'));
  report.checks.packagedOAuthMcpE2e = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  if (error.stderr) report.stderr = String(error.stderr).slice(-4000);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  report.cleanup = 'disposable extracted package removed';
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
