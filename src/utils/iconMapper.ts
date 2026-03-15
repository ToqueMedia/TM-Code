// src/utils/iconMapper.ts
// Resolve Material Icon Theme SVGs stored locally in src/assets/icons/**
// Requirements:
// - Folder icons by folder name: folder-<name>.svg and folder-<name>-open.svg
// - File icons by file extension: <ext>.svg; special handling for jsx/tsx

// Note: Vite deprecates `as: 'url'`; use `query: '?url', import: 'default'`.
const files = import.meta.glob('../assets/icons/**/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const ICONS_BY_FILENAME: Record<string, string> = {};
for (const fullPath in files) {
  const url = files[fullPath] as unknown as string;
  const base = fullPath.split('/').pop() as string; // e.g. folder-react.svg
  ICONS_BY_FILENAME[base.toLowerCase()] = url;
}

// Optional upstream-like mappings (allow user to drop JSON maps)
// - folders.json: { "controllers": "controller", "controller": "controller", ... }
// - files.json:   { "ts": "typescript", "tsx": "react_ts", "js": "javascript", ... }
// - names.json:   { "dockerfile": "docker", "readme": "markdown", ... }
const jsonMaps = import.meta.glob('../assets/icons/material/mappings/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, string>>;
let folderNameToIcon: Record<string, string> = {};
let fileExtToIcon: Record<string, string> = {};
let fileNameToIcon: Record<string, string> = {};
for (const p in jsonMaps) {
  const base = p.split('/').pop() as string;
  try {
    const data = jsonMaps[p];
    if (base === 'folders.json' && data && typeof data === 'object') {
      folderNameToIcon = { ...folderNameToIcon, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k).toLowerCase(), String(v)])) };
    } else if (base === 'files.json' && data && typeof data === 'object') {
      fileExtToIcon = { ...fileExtToIcon, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k).toLowerCase(), String(v)])) };
    } else if (base === 'names.json' && data && typeof data === 'object') {
      fileNameToIcon = { ...fileNameToIcon, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k).toLowerCase(), String(v)])) };
    }
  } catch {}
}

function resolveIconUrl(fileName: string): string | undefined {
  return ICONS_BY_FILENAME[fileName.toLowerCase()];
}

// Files: choose icon by extension
export function getFileIconByExtension(ext?: string, fileName?: string): string | undefined {
  // 0) Specific file name mapping if provided (e.g. dockerfile, readme)
  if (fileName) {
    const baseName = fileName.toLowerCase();
    const directName = fileNameToIcon[baseName];
    if (directName) {
      // Try name.svg
      const named = resolveIconUrl(`${directName}.svg`);
      if (named) return named;
      // Or fallback to folder- style if someone put it there
      const folderStyle = resolveIconUrl(`folder-${directName}.svg`);
      if (folderStyle) return folderStyle;
    }
  }

  if (!ext) return undefined;
  const key = ext.toLowerCase();

  // 1) Mapping JSON override
  if (fileExtToIcon[key]) {
    const iconBase = fileExtToIcon[key];
    const mapped = resolveIconUrl(`${iconBase}.svg`);
    if (mapped) return mapped;
  }

  // 2) Language special cases React
  if (key === 'tsx') {
    return (
      resolveIconUrl('react_ts.svg') ||
      resolveIconUrl('react.svg') ||
      resolveIconUrl('typescript.svg') ||
      resolveIconUrl('ts.svg') ||
      resolveIconUrl('javascript.svg')
    );
  }
  if (key === 'jsx') {
    return (
      resolveIconUrl('react.svg') ||
      resolveIconUrl('javascript.svg')
    );
  }

  // 3) Direct extension
  const direct = resolveIconUrl(`${key}.svg`);
  if (direct) return direct;

  // 4) Specials
  if (key === 'md' || key === 'mdown' || key === 'markdown') {
    return (
      resolveIconUrl('markdown.svg') ||
      resolveIconUrl('md.svg')
    );
  }
  if (key === 'ts') {
    return (
      resolveIconUrl('typescript.svg') ||
      resolveIconUrl('ts.svg') ||
      resolveIconUrl('javascript.svg')
    );
  }
  if (key === 'js' || key === 'mjs' || key === 'cjs') {
    return resolveIconUrl('javascript.svg');
  }

  // 5) Fallback
  return resolveIconUrl('file.svg');
}

// Helper: basic English plural to singular
function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 3) return word.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(word) && word.length > 2) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 1) return word.slice(0, -1);
  return word;
}

function generateFolderCandidates(name: string): string[] {
  const n = name.toLowerCase();
  const candidates = new Set<string>();
  candidates.add(n);
  candidates.add(singularize(n));

  // If contains separators, try last token and its singular
  const tokens = n.split(/[-_\.\s]+/).filter(Boolean);
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    candidates.add(last);
    candidates.add(singularize(last));
  }

  // Common aliases map (extend as needed)
  const ALIASES: Record<string, string[]> = {
    controllers: ['controller'],
    components: ['component'],
    services: ['service'],
    tests: ['test'],
    __tests__: ['test'],
    specs: ['test', 'spec'],
    images: ['image', 'img'],
    assets: ['asset'],
    styles: ['style', 'css'],
    scripts: ['script', 'js'],
    configs: ['config'],
    utils: ['util']
  };
  if (ALIASES[n]) {
    ALIASES[n].forEach(a => candidates.add(a));
  }

  return Array.from(candidates);
}

// Folders: choose icon by folder name, with fuzzy matching
export function getFolderIconByName(folderName?: string, isOpen?: boolean): string | undefined {
  const name = (folderName || '').toLowerCase();
  const tryResolve = (base: string, open?: boolean) => {
    const openSpecific = resolveIconUrl(`folder-${base}-open.svg`);
    const closedSpecific = resolveIconUrl(`folder-${base}.svg`);
    if (open && openSpecific) return openSpecific;
    if (!open && closedSpecific) return closedSpecific;
    // If only one exists, fallback to it
    return openSpecific || closedSpecific;
  };

  // 0) JSON mapping direct for folder names if present
  if (name && folderNameToIcon[name]) {
    const base = folderNameToIcon[name];
    const resolved = tryResolve(base, isOpen);
    if (resolved) return resolved;
  }

  if (name) {
    // 1) Exact and singular/aliases
    const candidates = generateFolderCandidates(name);
    for (const c of candidates) {
      const mapped = folderNameToIcon[c];
      if (mapped) {
        const resolved = tryResolve(mapped, isOpen);
        if (resolved) return resolved;
      }
      const found = tryResolve(c, isOpen);
      if (found) return found;
    }

    // 2) Prefix fuzzy (folder-<cand...>.svg)
    for (const c of candidates) {
      const prefix = `folder-${c}`;
      const match = Object.keys(ICONS_BY_FILENAME).find(k => k.startsWith(prefix));
      if (match) {
        // Prefer open variant if available
        const openVariant = match.replace(/\.svg$/, '-open.svg');
        if (isOpen && ICONS_BY_FILENAME[openVariant]) return ICONS_BY_FILENAME[openVariant];
        return ICONS_BY_FILENAME[match];
      }
    }
  }

  // Default folder icons
  if (isOpen) return resolveIconUrl('folder-open.svg') || resolveIconUrl('folder_open.svg');
  return resolveIconUrl('folder.svg');
}

// Folders: choose icon considering composite names in path (e.g., .github/workflows)
export function getFolderIconByPath(fullPath?: string, isOpen?: boolean): string | undefined {
  if (!fullPath) return undefined;
  const parts = fullPath.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase());
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  // 1) Try composite keys present in mapping (e.g., 'github/workflows', '.github/workflows')
  if (parent) {
    const combos = [ `${parent}/${last}`, `${parent.replace(/^\./,'')}/${last}`, `${parent}/${singularize(last)}` ];
    for (const combo of combos) {
      const mapped = folderNameToIcon[combo];
      if (mapped) {
        const openSpecific = resolveIconUrl(`folder-${mapped}-open.svg`);
        const closedSpecific = resolveIconUrl(`folder-${mapped}.svg`);
        if (isOpen && openSpecific) return openSpecific;
        return closedSpecific || openSpecific;
      }
    }
  }
  // 2) Fallback to name-based resolution
  return getFolderIconByName(last, isOpen);
}
