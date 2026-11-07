import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without a shell. Never throws on a non-zero exit.
 * `input` is written to the command's stdin (for prompts such as a disk image licence).
 */
export function run(file: string, args: string[], timeoutMs = 60_000, input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          const raw = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}
