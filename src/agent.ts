import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.ts';
import { toPlistXml } from './plist.ts';

export const AGENT_LABEL = 'dev.updiff.check';

export function launchAgentsDir(): string {
  return process.env.UPDIFF_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
}

export interface AgentOptions {
  nodePath: string;
  cliPath: string;
  home: string;
  intervalSeconds: number;
  watchPaths: string[];
  appsDirs: string[];
}

export function agentPlist(o: AgentOptions): string {
  const args = [o.nodePath, o.cliPath, 'check', '--notify', '--quiet', '--settle', '90', '--home', o.home];
  for (const d of o.appsDirs) args.push('--apps-dir', d);
  return toPlistXml({
    Label: AGENT_LABEL,
    ProgramArguments: args,
    // Runs after anything changes in the app folders, and on a timer as a fallback.
    WatchPaths: o.watchPaths,
    StartInterval: o.intervalSeconds,
    // An update writes many files; wait before running again.
    ThrottleInterval: 120,
    RunAtLoad: false,
    ProcessType: 'Background',
    LowPriorityIO: true,
    Nice: 10,
    StandardOutPath: join(o.home, 'agent.log'),
    StandardErrorPath: join(o.home, 'agent.log'),
  });
}

function domain(): string {
  return `gui/${userInfo().uid}`;
}

export async function installAgent(o: AgentOptions, load: boolean): Promise<{ path: string; loaded: boolean; message?: string }> {
  const dir = launchAgentsDir();
  await mkdir(dir, { recursive: true });
  await mkdir(o.home, { recursive: true });
  const path = join(dir, `${AGENT_LABEL}.plist`);
  if (load && existsSync(path)) await run('/bin/launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`]);
  await writeFile(path, agentPlist(o));
  if (!load) return { path, loaded: false };
  const res = await run('/bin/launchctl', ['bootstrap', domain(), path]);
  return { path, loaded: res.code === 0, message: res.code === 0 ? undefined : res.stderr.trim() };
}

export async function uninstallAgent(unload: boolean): Promise<{ path: string; existed: boolean }> {
  const path = join(launchAgentsDir(), `${AGENT_LABEL}.plist`);
  const existed = existsSync(path);
  if (unload) await run('/bin/launchctl', ['bootout', `${domain()}/${AGENT_LABEL}`]);
  await rm(path, { force: true });
  return { path, existed };
}

export async function agentStatus(): Promise<{ path: string; installed: boolean; loaded: boolean }> {
  const path = join(launchAgentsDir(), `${AGENT_LABEL}.plist`);
  const res = await run('/bin/launchctl', ['print', `${domain()}/${AGENT_LABEL}`]);
  return { path, installed: existsSync(path), loaded: res.code === 0 };
}

export async function notify(title: string, message: string): Promise<void> {
  const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  await run('/usr/bin/osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`]);
}
