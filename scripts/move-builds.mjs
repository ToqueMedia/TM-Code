import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json
const pkgPath = path.join(__dirname, '../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version || 'unknown';

// Get target triple from arguments if any
const targetTriple = process.argv[2];

// Source bundle directory
let srcBundleDir = path.join(__dirname, '../src-tauri/target');
if (targetTriple) {
  srcBundleDir = path.join(srcBundleDir, targetTriple, 'release/bundle');
} else {
  srcBundleDir = path.join(srcBundleDir, 'release/bundle');
}

// Destination directory on Desktop: Desktop/builds-desktop/v<version>
const desktopDir = path.join(os.homedir(), 'Desktop');
const destDir = path.join(desktopDir, 'builds-desktop', `v${version}`);

console.log(`Checking build artifacts in: ${srcBundleDir}`);
console.log(`Target destination: ${destDir}`);

if (!fs.existsSync(srcBundleDir)) {
  console.error(`Error: Source directory does not exist: ${srcBundleDir}`);
  process.exit(1);
}

// Create destination directory
fs.mkdirSync(destDir, { recursive: true });

// Recursively find and copy relevant files
function copyFiles(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    
    if (entry.isDirectory()) {
      // Recurse into subdirectories, but keep copying files to the root destination dir
      copyFiles(srcPath, dest);
    } else {
      const ext = path.extname(entry.name);
      // We are interested in installer and signature files
      const allowedExts = ['.dmg', '.exe', '.msi', '.deb', '.AppImage', '.sig', '.zip', '.gz'];
      if (allowedExts.includes(ext) || entry.name === 'latest.json') {
        const destName = entry.name.replace(/\s+/g, '.');
        const destPath = path.join(dest, destName);
        console.log(`Copying: ${entry.name} -> ${destName}`);
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

try {
  copyFiles(srcBundleDir, destDir);
  console.log(`\nSuccessfully copied all build files to: ${destDir}\n`);
} catch (err) {
  console.error('Error copying build files:', err);
  process.exit(1);
}
