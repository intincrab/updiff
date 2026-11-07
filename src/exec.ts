import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Never throws on a non-zero exit. */
export function run(file: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
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
  });
}
