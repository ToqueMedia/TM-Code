import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Get target from arguments
const target = process.argv[2];

// Check if TAURI_SIGNING_PRIVATE_KEY is already set
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyPath = path.join(os.homedir(), '.tauri', 'toquemedia-studio.key');
  if (fs.existsSync(keyPath)) {
    console.log(`\n🔑 Found signing key locally at: ${keyPath}`);
    const key = fs.readFileSync(keyPath, 'utf8').trim();
    process.env.TAURI_SIGNING_PRIVATE_KEY = key;
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
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
  console.error(`\n❌ Build failed with exit code: ${result.status}`);
  process.exit(result.status || 1);
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

console.log('\n✅ Build completed and files organized successfully!\n');
