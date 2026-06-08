import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// 1. Resolve version
let version = process.argv[2];
if (!version) {
  const tauriConfPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json');
  if (fs.existsSync(tauriConfPath)) {
    const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    version = tauriConf.version;
  }
}

if (!version) {
  console.error('❌ Error: Could not determine version. Please pass it as an argument: node scripts/generate-latest-json.mjs <version>');
  process.exit(1);
}

// Preserve the exact release tag passed by the workflow. Older releases used
// `v0.x.y`; 0.7.3+ uses plain `0.x.y`.
const tagVersion = version;
const bareVersion = tagVersion.startsWith('v') ? tagVersion.substring(1) : tagVersion;

const repo = 'ToqueMedia/TM-Code';
const baseUrl = `https://github.com/${repo}/releases/download/${tagVersion}`;
const pubDate = new Date().toISOString();

console.log(`\n🔍 Version determined: ${tagVersion} (Bare: ${bareVersion})`);
console.log(`📂 Repository: ${repo}`);
console.log(`🌐 Base URL: ${baseUrl}\n`);

// Create temp directory for downloading sigs
const sigsDir = path.join(projectRoot, 'temp_sigs');
if (fs.existsSync(sigsDir)) {
  fs.rmSync(sigsDir, { recursive: true, force: true });
}
fs.mkdirSync(sigsDir);

console.log(`📥 Downloading signatures from release ${tagVersion}...`);
try {
  execSync(`gh release download "${tagVersion}" --repo "${repo}" --pattern "*.sig" --dir "${sigsDir}" --clobber`, {
    stdio: 'inherit'
  });
} catch (error) {
  console.warn(`⚠️ Warning or error while downloading signatures: ${error.message}`);
}

// Function to read signature and ensure it is base64-encoded
function readSig(filename) {
  const filePath = path.join(sigsDir, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`❔ Signature file missing: ${filename}`);
    return '';
  }

  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (content.startsWith('untrusted')) {
    console.log(`📝 Detected raw Minisign signature for: ${filename}. Encoding to Base64...`);
    // Raw minisign has exact line-breaks which must be encoded
    const rawBuffer = fs.readFileSync(filePath);
    return rawBuffer.toString('base64');
  } else {
    console.log(`✅ Detected already Base64 encoded signature for: ${filename}`);
    return content.replace(/[\r\n\s]+/g, '');
  }
}

const linuxSig = readSig(`TM.Code_${bareVersion}_amd64.AppImage.sig`);
const darwinArm64Sig = readSig(`TM.Code_${bareVersion}_aarch64.app.tar.gz.sig`);
const darwinX64Sig = readSig(`TM.Code_${bareVersion}_x64.app.tar.gz.sig`);

// Look for Windows signature dynamically
let windowsSig = '';
let windowsZipFile = `TM.Code_${bareVersion}_x64_en-US.msi.zip`; // fallback default

const files = fs.readdirSync(sigsDir);
// 1. Try to find standard .zip.sig first (strongly recommended by Tauri)
let winSigFile = files.find(file => file.includes('_x64') && file.endsWith('.zip.sig'));

if (!winSigFile) {
  // 2. Fallback to other potential Windows signatures (.msi.sig or .exe.sig / -setup.exe.sig)
  winSigFile = files.find(file => 
    file.includes('_x64') && 
    (file.endsWith('.msi.sig') || file.endsWith('.exe.sig')) && 
    !file.endsWith('.app.tar.gz.sig')
  );
  if (winSigFile) {
    console.warn(`\n⚠️  WARNING: Found Windows signature "${winSigFile}" but it is not a ".zip.sig" file!`);
    console.warn(`   Tauri's auto-updater client on Windows REQUIRES ".zip" bundles (e.g. "TM.Code_${bareVersion}_x64_en-US.msi.zip").`);
    console.warn(`   Pointing the updater directly to a raw ".msi" or ".exe" will cause the update to fail on client machines.`);
    console.warn(`   Make sure to build and upload ".zip" and ".zip.sig" files to the release!\n`);
  }
}

if (winSigFile) {
  windowsSig = readSig(winSigFile);
  windowsZipFile = winSigFile.replace(/\.sig$/, '');
}

// Construct latest.json
const latestJson = {
  version: bareVersion,
  notes: `TM Code ${tagVersion}`,
  pub_date: pubDate,
  platforms: {}
};

if (linuxSig) {
  latestJson.platforms['linux-x86_64'] = {
    signature: linuxSig,
    url: `${baseUrl}/TM.Code_${bareVersion}_amd64.AppImage`
  };
}

if (darwinArm64Sig) {
  latestJson.platforms['darwin-aarch64'] = {
    signature: darwinArm64Sig,
    url: `${baseUrl}/TM.Code_${bareVersion}_aarch64.app.tar.gz`
  };
}

if (darwinX64Sig) {
  latestJson.platforms['darwin-x86_64'] = {
    signature: darwinX64Sig,
    url: `${baseUrl}/TM.Code_${bareVersion}_x64.app.tar.gz`
  };
}

if (windowsSig) {
  latestJson.platforms['windows-x86_64'] = {
    signature: windowsSig,
    url: `${baseUrl}/${windowsZipFile}`
  };
}

const latestJsonPath = path.join(projectRoot, 'latest.json');
fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2));

console.log('\n📄 Generated latest.json:');
console.log(JSON.stringify(latestJson, null, 2));

console.log(`\n📤 Uploading latest.json to release ${tagVersion}...`);
try {
  execSync(`gh release upload "${tagVersion}" "${latestJsonPath}" --repo "${repo}" --clobber`, {
    stdio: 'inherit'
  });
  console.log('\n🚀 Successfully updated latest.json on the GitHub release!');
} catch (error) {
  console.error(`❌ Error uploading latest.json: ${error.message}`);
}

// Clean up temp dir and local latest.json
fs.rmSync(sigsDir, { recursive: true, force: true });
fs.unlinkSync(latestJsonPath);
