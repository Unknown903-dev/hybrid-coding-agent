import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { generateDiff, validateProposal } from '../src/proposal-validation.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'proposal-validation-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.agent-proposals'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'example.ts'), 'export const answer = 41;\n');
  return root;
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: 'Correct the answer',
    file: 'src/example.ts',
    model: 'test-model',
    summary: 'Updates the value.',
    proposed_content: 'export const answer = 42;\n',
    checks: ['Not run by the model.'],
    risks: ['The value changes.'],
    ...overrides,
  };
}

async function writeProposal(root: string, value: unknown, name = 'proposal.json'): Promise<string> {
  const path = join(root, '.agent-proposals', name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

describe('validateProposal', () => {
  it('accepts a valid proposal and leaves the source unchanged', async () => {
    const root = await repository();
    const path = await writeProposal(root, proposal());
    const before = await readFile(join(root, 'src', 'example.ts'), 'utf8');

    const report = await validateProposal({ project: root, proposalPath: path });

    expect(report.valid).toBe(true);
    expect(report.diff?.unifiedDiff).toContain('-export const answer = 41;');
    expect(report.diff?.unifiedDiff).toContain('+export const answer = 42;');
    expect(await readFile(join(root, 'src', 'example.ts'), 'utf8')).toBe(before);
  });

  it('rejects malformed proposal JSON', async () => {
    const root = await repository();
    const path = await writeProposal(root, '{not json');
    const report = await validateProposal({ project: root, proposalPath: path });
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toContain('Malformed proposal JSON');
  });

  it('rejects missing required fields and unexpected fields', async () => {
    const root = await repository();
    const missingPath = await writeProposal(root, proposal({ summary: undefined }), 'missing.json');
    const extraPath = await writeProposal(root, proposal({ command: 'npm test' }), 'extra.json');

    const missing = await validateProposal({ project: root, proposalPath: missingPath });
    const extra = await validateProposal({ project: root, proposalPath: extraPath });

    expect(missing.valid).toBe(false);
    expect(missing.errors.join(' ')).toContain('summary');
    expect(extra.valid).toBe(false);
    expect(extra.errors.join(' ')).toContain('Unrecognized key');
  });

  it('rejects unchanged and empty proposed content', async () => {
    const root = await repository();
    const unchangedPath = await writeProposal(root, proposal({ proposed_content: 'export const answer = 41;\n' }), 'unchanged.json');
    const emptyPath = await writeProposal(root, proposal({ proposed_content: '  \n' }), 'empty.json');

    const unchanged = await validateProposal({ project: root, proposalPath: unchangedPath });
    const empty = await validateProposal({ project: root, proposalPath: emptyPath });

    expect(unchanged.errors).toContain('Proposal is unchanged from the target file.');
    expect(empty.errors).toContain('Proposed content is empty or whitespace-only.');
  });

  it('rejects target path traversal and absolute paths', async () => {
    const root = await repository();
    const traversalPath = await writeProposal(root, proposal({ file: '../outside.ts' }), 'traversal.json');
    const inRepositoryTraversalPath = await writeProposal(root, proposal({ file: 'src/../src/example.ts' }), 'in-repository-traversal.json');
    const absolutePath = await writeProposal(root, proposal({ file: resolve(root, 'src/example.ts') }), 'absolute.json');
    const windowsAbsolutePath = await writeProposal(root, proposal({ file: 'C:\\repo\\src\\example.ts' }), 'windows-absolute.json');

    const traversal = await validateProposal({ project: root, proposalPath: traversalPath });
    const inRepositoryTraversal = await validateProposal({ project: root, proposalPath: inRepositoryTraversalPath });
    const absolute = await validateProposal({ project: root, proposalPath: absolutePath });
    const windowsAbsolute = await validateProposal({ project: root, proposalPath: windowsAbsolutePath });

    expect(traversal.errors.join(' ')).toContain('traversal');
    expect(inRepositoryTraversal.errors.join(' ')).toContain('traversal');
    expect(absolute.errors.join(' ')).toContain('absolute paths');
    expect(windowsAbsolute.errors.join(' ')).toContain('absolute paths');
  });

  it('rejects a target symlink that escapes the repository', async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), 'proposal-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'secret.ts'), 'secret\n');
    await symlink(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    const path = await writeProposal(root, proposal({ file: 'src/linked.ts' }));

    const report = await validateProposal({ project: root, proposalPath: path });

    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toContain('escapes the repository through a symlink');
  });

  it('rejects protected files', async () => {
    const root = await repository();
    await writeFile(join(root, 'package-lock.json'), '{}\n');
    const path = await writeProposal(root, proposal({ file: 'package-lock.json', proposed_content: '{"changed":true}\n' }));

    const report = await validateProposal({ project: root, proposalPath: path });

    expect(report.valid).toBe(false);
    expect(report.errors.join(' ')).toContain('protected');
  });

  it('flags large diffs for review without rejecting them', async () => {
    const root = await repository();
    const original = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n') + '\n';
    const changed = Array.from({ length: 20 }, (_, index) => `changed ${index}`).join('\n') + '\n';
    await writeFile(join(root, 'src', 'example.ts'), original);
    const path = await writeProposal(root, proposal({ proposed_content: changed }));

    const report = await validateProposal({
      project: root,
      proposalPath: path,
      thresholds: { changedLines: 5, changedRatio: 0.2 },
    });

    expect(report.valid).toBe(true);
    expect(report.requiresManualReview).toBe(true);
    expect(report.diff?.changedLines).toBeGreaterThan(5);
    expect(report.warnings.join(' ')).toContain('Large diff');
  });

  it('rejects invalid proposal file paths, including symlink escapes', async () => {
    const root = await repository();
    const outside = await mkdtemp(join(tmpdir(), 'proposal-file-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'proposal.json'), JSON.stringify(proposal()));
    await symlink(join(outside, 'proposal.json'), join(root, '.agent-proposals', 'linked.json'));

    const missing = await validateProposal({ project: root, proposalPath: '.agent-proposals/missing.json' });
    const traversal = await validateProposal({ project: root, proposalPath: '../proposal.json' });
    const symlinked = await validateProposal({ project: root, proposalPath: '.agent-proposals/linked.json' });

    expect(missing.valid).toBe(false);
    expect(traversal.errors.join(' ')).toContain('inside the target Git repository');
    expect(symlinked.errors.join(' ')).toContain('escapes the repository through a symlink');
  });
});

describe('generateDiff', () => {
  it('generates a unified diff with accurate added and removed line counts', () => {
    const diff = generateDiff('src/example.ts', 'one\ntwo\n', 'one\nthree\n');

    expect(diff.unifiedDiff).toContain('--- a/src/example.ts');
    expect(diff.unifiedDiff).toContain('+++ b/src/example.ts');
    expect(diff.unifiedDiff).toContain('-two');
    expect(diff.unifiedDiff).toContain('+three');
    expect(diff.addedLines).toBe(1);
    expect(diff.removedLines).toBe(1);
    expect(diff.changedLines).toBe(2);
  });

  it('identifies a large formatting-only change', () => {
    const original = Array.from({ length: 12 }, () => 'const value=1;').join('\n');
    const proposed = Array.from({ length: 12 }, () => 'const value = 1;').join('\n');
    const diff = generateDiff('src/example.ts', original, proposed, { formattingOnlyLines: 5 });

    expect(diff.formattingOnly).toBe(true);
    expect(diff.findings.join(' ')).toContain('formatting-only');
  });
});
