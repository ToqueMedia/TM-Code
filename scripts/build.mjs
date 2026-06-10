import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(arg => arg.startsWith('--')));

// Get target from arguments
const target = positionalArgs[0];
const isUnsignedBuild = flags.has('--unsigned');
const requireUpdaterArtifacts = flags.has('--require-updater-artifacts');
const isWindowsTarget = target?.includes('windows') || (os.platform() === 'win32' && !target);
const tauriConfigPath = path.join(__dirname, '../src-tauri/tauri.conf.json');
let unsignedWindowsConfigPath = '';

function getWindowsCertificateThumbprint() {
  try {
    const config = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
    return config?.bundle?.windows?.certificateThumbprint || '';
  } catch {
    return '';
  }
}

function hasWindowsSigningCertificate(thumbprint) {
  if (!thumbprint || os.platform() !== 'win32') {
    return false;
  }

  const command = [
    `$thumb = '${thumbprint.replace(/'/g, "''")}';`,
    '$paths = @("Cert:\\CurrentUser\\My\\$thumb", "Cert:\\LocalMachine\\My\\$thumb");',
    '$cert = Get-ChildItem -Path $paths -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.HasPrivateKey } |',
    '  Select-Object -First 1;',
    'if ($cert) { exit 0 } else { exit 1 }'
  ].join(' ');

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command
  ], {
    stdio: 'ignore',
    shell: false
  });

  return result.status === 0;
}

// Check if TAURI_SIGNING_PRIVATE_KEY is already set
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !isUnsignedBuild) {
  const keyPath = path.join(os.homedir(), '.tauri', 'toquemedia-studio.key');
  if (fs.existsSync(keyPath)) {
    console.log(`\n🔑 Found signing key locally at: ${keyPath}`);
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    process.env.TAURI_SIGNING_PRIVATE_KEY = key;
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
  } else if (isWindowsTarget || requireUpdaterArtifacts) {
    console.error('\n❌ TAURI_SIGNING_PRIVATE_KEY is required for signed Windows release builds.');
    console.error('   Without it, Tauri will not generate the Windows updater setup.exe.sig artifact.');
    console.error(`   Save the key at: ${keyPath}`);
    console.error('   Or run the explicit unsigned script: yarn tauri:build:win-x64:unsigned\n');
    process.exit(1);
  } else {
    console.warn('\n================================================================================');
    console.warn('⚠️  WARNING: TAURI_SIGNING_PRIVATE_KEY is not set!');
    console.warn(`   No signing key found at: ${keyPath}`);
    console.warn('================================================================================');
    console.warn('   The build will proceed, but Tauri will NOT generate the auto-update artifacts:');
    console.warn('   - No ".zip" updater packages (e.g. .msi.zip) will be created.');
    console.warn('   - No signature (".sig") files will be generated.');
    console.warn('--------------------------------------------------------------------------------');
    console.warn('💡  INSTRUCTION FOR FUTURE GENERATIONS / RELEASES:');
    console.warn('   To automatically generate the updater zip and signatures during the build,');
    console.warn('   make sure the signing key is available.');
    console.warn('');
    if (os.platform() === 'win32') {
      console.warn('   Option 1: Save your private key content to the file:');
      console.warn('             %USERPROFILE%\\.tauri\\toquemedia-studio.key');
      console.warn('');
      console.warn('   Option 2: Set the environment variable in PowerShell before building:');
      console.warn('             $env:TAURI_SIGNING_PRIVATE_KEY="your_private_key_here"');
    } else {
      console.warn('   Option 1: Save your private key content to the file:');
      console.warn('             ~/.tauri/toquemedia-studio.key');
      console.warn('');
      console.warn('   Option 2: Set the environment variable in terminal before building:');
      console.warn('             export TAURI_SIGNING_PRIVATE_KEY="your_private_key_here"');
    }
    console.warn('================================================================================\n');
  }
}

// Build tauri build command
const args = ['tauri', 'build'];
if (target) {
  args.push('--target', target);
}

if (isUnsignedBuild) {
  args.push('--no-sign');
} else if (isWindowsTarget) {
  const thumbprint = getWindowsCertificateThumbprint();
  if (!hasWindowsSigningCertificate(thumbprint)) {
    console.warn('\nWindows code-signing certificate is not installed or has no private key.');
    console.warn(`Skipping Authenticode signing for this local build: ${thumbprint || 'no thumbprint configured'}`);
    console.warn('Install the certificate in CurrentUser\\My or LocalMachine\\My to produce signed Windows installers.\n');

    if (requireUpdaterArtifacts) {
      unsignedWindowsConfigPath = path.join(os.tmpdir(), `tauri-windows-no-codesign-${process.pid}.json`);
      fs.writeFileSync(unsignedWindowsConfigPath, JSON.stringify({
        bundle: {
          windows: {
            certificateThumbprint: null
          }
        }
      }));
      args.push('--config', unsignedWindowsConfigPath);
    } else {
      args.push('--no-sign');
    }
  }
}

console.log(`🚀 Running build command: npx ${args.join(' ')}\n`);

const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    VITE_USE_EMULATORS: 'false',
    VITE_WORKER_URL: 'https://api-agents.toquemedia.net'
  }
});

if (result.status !== 0) {
  if (unsignedWindowsConfigPath) {
    fs.rmSync(unsignedWindowsConfigPath, { force: true });
  }
  console.error(`\n❌ Build failed with exit code: ${result.status}`);
  process.exit(result.status || 1);
}

if (unsignedWindowsConfigPath) {
  fs.rmSync(unsignedWindowsConfigPath, { force: true });
}

// Run move-builds.mjs
const moveArgs = [path.join(__dirname, 'move-builds.mjs')];
if (target) {
  moveArgs.push(target);
}

console.log(`\n📦 Organizing build files: node ${moveArgs.join(' ')}\n`);
const moveResult = spawnSync('node', moveArgs, {
  stdio: 'inherit',
  shell: true
});

if (moveResult.status !== 0) {
  console.error(`❌ Organizing builds failed with exit code: ${moveResult.status}`);
  process.exit(moveResult.status || 1);
}

if (isWindowsTarget && requireUpdaterArtifacts) {
  const pkgPath = path.join(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = pkg.version || 'unknown';
  const destDir = path.join(os.homedir(), 'Desktop', 'builds-desktop', `v${version}`);
  const files = fs.existsSync(destDir) ? fs.readdirSync(destDir) : [];
  const setupFile = `TM.Code_${version}_x64-setup.exe`;
  const setupSigFile = `${setupFile}.sig`;
  const hasSetup = files.includes(setupFile);
  const hasSetupSig = files.includes(setupSigFile);

  if (!hasSetup || !hasSetupSig) {
    console.error('\n❌ Windows updater artifacts are missing after build.');
    console.error(`   Checked: ${destDir}`);
    console.error(`   Required: ${setupFile} and ${setupSigFile}.`);
    console.error('   Do not publish latest.json/release for Windows without these files.\n');
    process.exit(1);
  }
}

console.log('\n✅ Build completed and files organized successfully!\n');
