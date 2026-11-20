import { splitSimple, words } from '../hook/shell-paths.js';
import type { CommandEvent } from './sigma.js';

/**
 * The registry events a command would cause, for the Sigma registry rules (Sysmon-style events: TargetObject is the key
 * and value name, Details the data, EventType what happened). They are read from the commands that write the registry
 * in a way the line itself shows: `reg add` and `reg delete`, and the PowerShell cmdlets Set-ItemProperty,
 * New-ItemProperty and Remove-ItemProperty on a registry path. A script file, `reg import` and a path built at run time
 * are not seen.
 *
 * Assumptions: HKCU is written as HKU\S-1-5-21-0-0-0-1000 (Sysmon logs the user's SID, which the guard does not know),
 * a DWORD or QWORD value is written the way Sysmon prints it (DWORD (0x00000001)), the Image is the program as in the
 * process events.
 */

const SYSTEM = 'C:\\Windows\\System32\\';
const POWERSHELL_IMAGE = SYSTEM + 'WindowsPowerShell\\v1.0\\powershell.exe';
const HKCU_AS = 'HKU\\S-1-5-21-0-0-0-1000';
const MAX_EVENTS = 50;

const baseName = (word: string): string => word.replace(/\\/g, '/').split('/').pop() ?? word;

/** A registry path as the rules see it: HKLM\..., or null when it is not a registry path. */
export function normalizeKey(raw: string): string | null {
  const k = raw.trim().replace(/^registry::/i, '');
  const m = /^(hkey_local_machine|hklm|hkey_current_user|hkcu|hkey_classes_root|hkcr|hkey_users|hku|hkey_current_config|hkcc):?(?:\\(.*))?$/i.exec(k);
  if (!m) return null;
  const root = m[1].toLowerCase();
  const head = root === 'hklm' || root === 'hkey_local_machine' ? 'HKLM' : root === 'hkcu' || root === 'hkey_current_user' ? HKCU_AS : root === 'hkcr' || root === 'hkey_classes_root' ? 'HKCR' : root === 'hku' || root === 'hkey_users' ? 'HKU' : 'HKCC';
  const rest = (m[2] ?? '').replace(/\\+$/, '');
  return rest ? `${head}\\${rest}` : head;
}

/** The data as Sysmon prints it. */
function detailsOf(type: string | undefined, data: string | undefined): string {
  if (data === undefined) return '(Empty)';
  const t = (type ?? 'REG_SZ').toLowerCase().replace(/^reg_/, '');
  if (t === 'dword' || t === 'qword') {
    const n = /^0x[0-9a-f]+$/i.test(data) ? parseInt(data, 16) : /^\d+$/.test(data) ? parseInt(data, 10) : NaN;
    if (!Number.isFinite(n)) return data;
    return `${t === 'dword' ? 'DWORD' : 'QWORD'} (0x${n.toString(16).padStart(t === 'dword' ? 8 : 16, '0')})`;
  }
  if (t === 'binary') return 'Binary Data';
  return data;
}

function regExe(ws: string[], image: string): CommandEvent | null {
  const verb = ws[1]?.toLowerCase();
  if (verb !== 'add' && verb !== 'delete') return null;
  let key: string | undefined;
  let name: string | undefined;
  let data: string | undefined;
  let type: string | undefined;
  let defaultValue = false;
  for (let i = 2; i < ws.length; i++) {
    const w = ws[i];
    const lw = w.toLowerCase();
    if (lw === '/v') name = ws[++i];
    else if (lw === '/ve') defaultValue = true;
    else if (lw === '/d') data = ws[++i];
    else if (lw === '/t') type = ws[++i];
    else if (lw === '/s') i++;
    else if (!w.startsWith('/') && key === undefined) key = w;
  }
  const k = key === undefined ? null : normalizeKey(key);
  if (!k) return null;
  const target = name !== undefined ? `${k}\\${name}` : defaultValue ? `${k}\\(Default)` : k;
  const hasValue = name !== undefined || defaultValue;
  if (verb === 'add') {
    return hasValue
      ? { Image: image, TargetObject: target, Details: detailsOf(type, data), EventType: 'SetValue', LogsourceCategory: 'registry_set' }
      : { Image: image, TargetObject: k, EventType: 'CreateKey', LogsourceCategory: 'registry_event' };
  }
  return { Image: image, TargetObject: target, EventType: hasValue ? 'DeleteValue' : 'DeleteKey', LogsourceCategory: 'registry_delete' };
}

const PARAMS: Record<string, 'path' | 'name' | 'value' | 'type'> = { path: 'path', literalpath: 'path', pspath: 'path', name: 'name', value: 'value', propertytype: 'type', type: 'type' };

function cmdlet(ws: string[], kind: 'set' | 'remove'): CommandEvent | null {
  const named: Partial<Record<'path' | 'name' | 'value' | 'type', string>> = {};
  const positional: string[] = [];
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (w.startsWith('-')) {
      const param = PARAMS[w.slice(1).toLowerCase()];
      if (param && i + 1 < ws.length) named[param] = ws[++i];
    } else positional.push(w);
  }
  const path = named.path ?? positional.shift();
  const name = named.name ?? positional.shift();
  const value = named.value ?? (kind === 'set' ? positional.shift() : undefined);
  const k = path === undefined ? null : normalizeKey(path);
  if (!k || name === undefined) return null;
  const target = `${k}\\${name}`;
  if (kind === 'remove') return { Image: POWERSHELL_IMAGE, TargetObject: target, EventType: 'DeleteValue', LogsourceCategory: 'registry_delete' };
  const type = named.type ?? (value !== undefined && /^\d+$/.test(value) ? 'DWord' : undefined);
  return { Image: POWERSHELL_IMAGE, TargetObject: target, Details: detailsOf(type, value), EventType: 'SetValue', LogsourceCategory: 'registry_set' };
}

export function registryEventsOf(command: string, depth = 0): CommandEvent[] {
  const events: CommandEvent[] = [];
  for (const simple of splitSimple(command)) {
    const ws = words(simple);
    if (ws.length === 0) continue;
    const prog = baseName(ws[0]).toLowerCase().replace(/\.exe$/, '');
    let event: CommandEvent | null = null;
    if (prog === 'reg') event = regExe(ws, `${SYSTEM}reg.exe`);
    else if (prog === 'set-itemproperty' || prog === 'new-itemproperty' || prog === 'sp') event = cmdlet(ws, 'set');
    else if (prog === 'remove-itemproperty' || prog === 'rp') event = cmdlet(ws, 'remove');
    else if (depth === 0 && (prog === 'cmd' || prog === 'powershell' || prog === 'pwsh')) {
      const at = ws.findIndex((w, i) => i > 0 && (prog === 'cmd' ? /^\/[ck]$/i.test(w) : /^-(c|command)$/i.test(w)));
      if (at >= 0 && at + 1 < ws.length) events.push(...registryEventsOf(ws.slice(at + 1).join(' '), depth + 1));
    }
    if (event) events.push(event);
    if (events.length >= MAX_EVENTS) break;
  }
  return events.slice(0, MAX_EVENTS);
}
