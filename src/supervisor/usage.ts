import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CloudTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CloudUsageEvent {
  call_id: string;
  timestamp: string;
  operation: 'plan' | 'review';
  status: 'started' | 'completed' | 'failed';
  model?: string;
  usage?: CloudTokenUsage;
  error?: string;
}

export interface CloudUsageReport {
  schema_version: '1.0';
  task_id: string;
  cloud_enabled: boolean;
  call_budget: number;
  calls_started: number;
  calls_completed: number;
  calls_failed: number;
  token_usage_reported: CloudTokenUsage;
  events: CloudUsageEvent[];
}

export class CloudDisabledError extends Error {}
export class CloudBudgetExceededError extends Error {}

function emptyUsage(): CloudTokenUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function sanitizeError(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+/gi, '[REDACTED_CREDENTIAL]')
    .slice(0, 2_000);
}

export class CloudUsageManager {
  readonly report: CloudUsageReport;

  constructor(options: { taskId: string; cloudEnabled: boolean; callBudget?: number }) {
    const callBudget = options.callBudget ?? 2;
    if (!Number.isInteger(callBudget) || callBudget < 0 || callBudget > 20) {
      throw new Error('Cloud call budget must be an integer between 0 and 20.');
    }
    this.report = {
      schema_version: '1.0',
      task_id: options.taskId,
      cloud_enabled: options.cloudEnabled,
      call_budget: callBudget,
      calls_started: 0,
      calls_completed: 0,
      calls_failed: 0,
      token_usage_reported: emptyUsage(),
      events: [],
    };
  }

  begin(operation: 'plan' | 'review', model?: string): string {
    if (!this.report.cloud_enabled) throw new CloudDisabledError('Cloud supervisor calls are disabled. Explicit authorization is required.');
    if (this.report.calls_started >= this.report.call_budget) {
      throw new CloudBudgetExceededError(`Cloud call budget exhausted (${this.report.call_budget}).`);
    }
    const callId = randomUUID();
    this.report.calls_started += 1;
    this.report.events.push({
      call_id: callId,
      timestamp: new Date().toISOString(),
      operation,
      status: 'started',
      ...(model ? { model: model.slice(0, 200) } : {}),
    });
    return callId;
  }

  complete(callId: string, usage?: CloudTokenUsage | null, model?: string): void {
    const started = this.report.events.find(event => event.call_id === callId && event.status === 'started');
    if (!started) throw new Error(`Unknown cloud call ID: ${callId}`);
    if (usage) {
      for (const key of Object.keys(this.report.token_usage_reported) as Array<keyof CloudTokenUsage>) {
        if (!Number.isInteger(usage[key]) || usage[key] < 0) throw new Error(`Invalid reported token usage for ${key}.`);
      }
    }
    this.report.calls_completed += 1;
    if (usage) {
      for (const key of Object.keys(this.report.token_usage_reported) as Array<keyof CloudTokenUsage>) {
        this.report.token_usage_reported[key] += usage[key];
      }
    }
    this.report.events.push({
      call_id: callId,
      timestamp: new Date().toISOString(),
      operation: started.operation,
      status: 'completed',
      ...(model ?? started.model ? { model: (model ?? started.model)!.slice(0, 200) } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  fail(callId: string, error: unknown, model?: string): void {
    const started = this.report.events.find(event => event.call_id === callId && event.status === 'started');
    if (!started) throw new Error(`Unknown cloud call ID: ${callId}`);
    this.report.calls_failed += 1;
    this.report.events.push({
      call_id: callId,
      timestamp: new Date().toISOString(),
      operation: started.operation,
      status: 'failed',
      ...(model ?? started.model ? { model: (model ?? started.model)!.slice(0, 200) } : {}),
      error: sanitizeError(error instanceof Error ? error.message : String(error)),
    });
  }

  async save(projectRoot: string): Promise<string> {
    const runs = resolve(projectRoot, '.agent-runs');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const path = resolve(runs, `${this.report.task_id}-${randomUUID()}-supervisor-usage.json`);
    const temporary = resolve(runs, `.${this.report.task_id}.${randomUUID()}.usage.tmp`);
    await writeFile(temporary, JSON.stringify(this.report, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    return path;
  }
}
