import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function findTool(name) {
  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  if (explicit && existsSync(explicit)) return explicit;
  // where.exe writes OEM text on Windows; decoding it as UTF-8 breaks Chinese usernames.
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Command -Name '${name}.exe' -CommandType Application | Select-Object -First 1 -ExpandProperty Source`], { encoding: 'utf8', windowsHide: true }).trim();
  if (!result || !existsSync(result)) throw new Error(`${name}.exe missing; set ${name.toUpperCase()}_PATH to its location.`);
  return result;
}
