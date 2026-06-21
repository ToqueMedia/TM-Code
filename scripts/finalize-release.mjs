import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const repo = 'ToqueMedia/TM-Code';

function loadGithubTokenFromDotEnv() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return;
  }

  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const env = fs.readFileSync(envPath, 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*(GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (value) {
      process.env[match[1]] = value;
      if (match[1] === 'GITHUB_TOKEN' && !process.env.GH_TOKEN) {
        process.env.GH_TOKEN = value;
      }
      return;
    }
  }
}

loadGithubTokenFromDotEnv();

function resolveCommand(command) {
  if (process.platform !== 'win32') {
    return command;
  }

  const whereResult = spawnSync('where.exe', [command], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false
  });

  if (whereResult.status === 0) {
    const resolved = whereResult.stdout.split(/\r?\n/).find(Boolean);
    if (resolved) {
      return resolved.trim();
    }
  }

  return command;
}

const ghCommand = resolveCommand('gh');

function resolveVersion() {
  const argVersion = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (argVersion) {
    return argVersion;
  }

  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version) {
    return pkg.version;
  }

  console.error('Error: Could not determine release version.');
  console.error('Usage: yarn release:finalize [version]');
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(resolveCommand(command), args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    ...options
  });

  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status || 1);
  }

  return result.stdout || '';
}

function ensureGithubCliAuth() {
  const ghVersion = spawnSync(ghCommand, ['--version'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false
  });

  if (ghVersion.status !== 0) {
    console.error('Error: GitHub CLI is required to finalize the release.');
    console.error('Install it from: https://cli.github.com');
    process.exit(1);
  }

  const authStatus = spawnSync(ghCommand, ['auth', 'status', '--hostname', 'github.com'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false
  });

  if (authStatus.status !== 0) {
    console.error('Error: GitHub CLI is not authenticated.');
    console.error('Run one of these before finalizing the release:');
    console.error('  gh auth login');
    console.error('  GH_TOKEN=<token> yarn release:finalize');
    console.error('');
    console.error('The token needs release write permission for ToqueMedia/TM-Code.');
    process.exit(authStatus.status || 1);
  }
}

const version = resolveVersion();
const bareVersion = version.startsWith('v') ? version.substring(1) : version;

ensureGithubCliAuth();

console.log(`\nChecking release assets for ${version}...`);

const releaseJson = run('gh', [
  'release',
  'view',
  version,
  '--repo',
  repo,
  '--json',
  'isDraft,assets'
]);

const release = JSON.parse(releaseJson);
const assetNames = new Set((release.assets || []).map(asset => asset.name));

const requiredAssets = [
  `TM.Code_${bareVersion}_amd64.AppImage`,
  `TM.Code_${bareVersion}_amd64.AppImage.sig`,
  `TM.Code_${bareVersion}_aarch64.app.tar.gz`,
  `TM.Code_${bareVersion}_aarch64.app.tar.gz.sig`,
  `TM.Code_${bareVersion}_x64.app.tar.gz`,
  `TM.Code_${bareVersion}_x64.app.tar.gz.sig`,
  `TM.Code_${bareVersion}_x64-setup.exe`,
  `TM.Code_${bareVersion}_x64-setup.exe.sig`
];

const missingAssets = requiredAssets.filter(name => !assetNames.has(name));

if (missingAssets.length > 0) {
  console.error('\nRelease is not ready to publish. Missing required updater assets:');
  for (const name of missingAssets) {
    console.error(`- ${name}`);
  }
  console.error('\nUpload the missing assets, then run: yarn release:finalize');
  process.exit(1);
}

const optionalWindowsAssets = [
  `TM.Code_${bareVersion}_x64_en-US.msi`,
  `TM.Code_${bareVersion}_x64_en-US.msi.sig`
];

const missingOptionalAssets = optionalWindowsAssets.filter(name => !assetNames.has(name));
if (missingOptionalAssets.length > 0) {
  console.warn('\nWarning: Windows manual installer assets are missing:');
  for (const name of missingOptionalAssets) {
    console.warn(`- ${name}`);
  }
  console.warn('The updater can still work through the setup.exe artifact.\n');
}

console.log('All required updater assets are present.');

console.log('\nGenerating and uploading latest.json...');
run(process.execPath, [path.join(__dirname, 'generate-latest-json.mjs'), version], {
  stdio: 'inherit'
});

if (release.isDraft) {
  console.log('\nPublishing draft release...');
  run('gh', [
    'release',
    'edit',
    version,
    '--repo',
    repo,
    '--draft=false'
  ], {
    stdio: 'inherit'
  });
} else {
  console.log('\nRelease is already published. latest.json was refreshed.');
}

console.log(`\nRelease ${version} is finalized.`);
