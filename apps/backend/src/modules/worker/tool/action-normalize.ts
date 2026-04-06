/** LLM 可能输出 write_file / writeFile 等，统一为 camelCase 白名单键 */
const ALIASES: Record<string, string> = {
  write_file: 'writeFile',
  read_file: 'readFile',
  list_files: 'listFiles',
  listfiles: 'listFiles',
  listdir: 'listFiles',
  ls: 'listFiles',
  run_command: 'runCommand',
  create_directory: 'createDirectory',
  mkdir: 'createDirectory',
  noop: 'noop',
  none: 'noop',
  skip: 'noop',
};

const CANONICAL = new Set([
  'writeFile',
  'readFile',
  'listFiles',
  'runCommand',
  'createDirectory',
  'noop',
]);

export function normalizeAction(raw: string): string {
  const s = raw.trim();
  if (!s) return 'noop';
  if (CANONICAL.has(s)) return s;
  const snake = s.replace(/-/g, '_').toLowerCase();
  if (snake in ALIASES) return ALIASES[snake];
  return s;
}
