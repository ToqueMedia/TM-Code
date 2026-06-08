import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const repo = 'ToqueMedia/TM-Code';

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
  const result = spawnSync(command, args, {
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

const version = resolveVersion();
const bareVersion = version.startsWith('v') ? version.substring(1) : version;

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
