// src/utils/iconMapper.ts
// Lightweight mapping for Material Icon Theme SVGs with Vite import.meta.glob

const files = import.meta.glob('../assets/icons/material/*.svg', { eager: true, as: 'url' }) as Record<string, string>;

const byName: Record<string, string> = {};
for (const p in files) {
  const url = files[p] as unknown as string;
  const base = p.split('/').pop() as string;
  byName[base] = url;
}

// Map common extensions to Material Icon Theme filenames
const FILE_ICON_MAP: Record<string, string> = {
  ts: 'file_type_typescript.svg',
  tsx: 'file_type_react.svg',
  js: 'file_type_js.svg',
  jsx: 'file_type_react.svg',
  json: 'file_type_json.svg',
  html: 'file_type_html.svg',
  css: 'file_type_css.svg',
  md: 'file_type_markdown.svg'
};

export function getFileIconUrl(ext?: string): string | undefined {
  if (!ext) return undefined;
  const key = ext.toLowerCase();
  const fileName = FILE_ICON_MAP[key];
  if (!fileName) return undefined;
  return byName[fileName];
}

export function getFolderIconUrl(isOpen: boolean): string | undefined {
  return byName[isOpen ? 'folder-open.svg' : 'folder.svg'];
}
