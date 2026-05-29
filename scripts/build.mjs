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
    console.warn('\n⚠️ Warning: TAURI_SIGNING_PRIVATE_KEY is not set and no key found at ~/.tauri/toquemedia-studio.key.');
    console.warn('The build will proceed but WITHOUT auto-update signature generation (.sig).\n');
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
