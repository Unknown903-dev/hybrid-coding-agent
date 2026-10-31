import { spawn } from 'node:child_process';
import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

const commandSchema = z.object({
  name: z.string().trim().min(1),
  executable: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().max(600_000).default(DEFAULT_TIMEOUT_MS),
  max_output_bytes: z.number().int().positive().max(5_000_000).default(DEFAULT_MAX_OUTPUT_BYTES),
}).strict();

const configSchema = z.object({ commands: z.array(commandSchema).max(20) }).strict();

export type TrustedCommand = z.infer<typeof commandSchema>;

export interface CheckResult {
  name: string;
  executable: string;
  args: string[];
  status: 'passed' | 'failed';
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  output_truncated: boolean;
  error?: string;
}

async function executableExists(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(() => true, () => false);
}

function localBinary(projectRoot: string, name: string): string {
  return resolve(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
}

export async function loadTrustedCommands(projectRoot: string): Promise<TrustedCommand[]> {
  const configPath = resolve(projectRoot, '.agent-validation.json');
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('configuration must be a regular, non-symlink file');
    if (stat.size > 100_000) throw new Error('configuration exceeds 100000 bytes');
    const parsed = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
    return parsed.commands;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`Invalid trusted validation config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let scripts: Record<string, unknown> = {};
  try {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = packageJson.scripts ?? {};
  } catch {
    return [];
  }

  const commands: TrustedCommand[] = [];
  const candidates: Array<[string, string, string[]]> = [
    ['typecheck', 'tsc', ['--noEmit']],
    ['lint', 'eslint', ['.']],
    ['test', 'vitest', ['run']],
  ];
  for (const [script, binary, args] of candidates) {
    const executable = localBinary(projectRoot, binary);
    if (typeof scripts[script] === 'string' && await executableExists(executable)) {
      commands.push({
        name: script,
        executable,
        args,
        timeout_ms: DEFAULT_TIMEOUT_MS,
        max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
    }
  }
  return commands;
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'ComSpec', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (!env.PATH) env.PATH = process.platform === 'win32' ? '' : ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
  return env;
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

export async function runTrustedCommand(command: TrustedCommand, cwd: string): Promise<CheckResult> {
  const started = Date.now();
  return new Promise(resolveResult => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let totalBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let spawnError: string | undefined;
    let finished = false;

    const child = spawn(command.executable, command.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: restrictedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const remaining = Math.max(command.max_output_bytes - totalBytes, 0);
      const accepted = chunk.subarray(0, remaining);
      if (stream === 'stdout') stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);
      totalBytes += accepted.length;
      if (accepted.length < chunk.length && !outputTruncated) {
        outputTruncated = true;
        terminate(child, 'SIGTERM');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      setTimeout(() => terminate(child, 'SIGKILL'), 1_000).unref();
    }, command.timeout_ms);
    timeout.unref();

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      const passed = exitCode === 0 && !timedOut && !outputTruncated && !spawnError;
      resolveResult({
        name: command.name,
        executable: command.executable,
        args: [...command.args],
        status: passed ? 'passed' : 'failed',
        exit_code: exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        output_truncated: outputTruncated,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };

    child.on('error', error => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
