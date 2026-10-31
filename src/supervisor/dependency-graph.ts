export interface DependencyTask {
  task_id: string;
  dependencies: string[];
}

export class DependencyGraphError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Invalid dependency graph: ${reasons.join('; ')}`);
  }
}

/** Validate and deterministically topologically order tasks. Equal-priority tasks use task ID order. */
export function orderTasksByDependencies<T extends DependencyTask>(tasks: T[]): T[] {
  const errors: string[] = [];
  const byId = new Map<string, T>();
  for (const task of tasks) {
    if (byId.has(task.task_id)) errors.push(`Duplicate task ID: ${task.task_id}.`);
    else byId.set(task.task_id, task);
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      errors.push(`Task ${task.task_id} contains duplicate dependencies.`);
    }
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.task_id) errors.push(`Task ${task.task_id} cannot depend on itself.`);
      else if (!byId.has(dependency)) errors.push(`Task ${task.task_id} has unknown dependency ${dependency}.`);
    }
  }
  if (errors.length > 0) throw new DependencyGraphError([...new Set(errors)]);

  const indegree = new Map(tasks.map(task => [task.task_id, task.dependencies.length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.task_id);
      dependents.set(dependency, list);
    }
  }
  for (const list of dependents.values()) list.sort();
  const ready = tasks.filter(task => indegree.get(task.task_id) === 0).map(task => task.task_id).sort();
  const ordered: T[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = indegree.get(dependent)! - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== tasks.length) {
    const cyclic = tasks.map(task => task.task_id).filter(id => !ordered.some(task => task.task_id === id)).sort();
    throw new DependencyGraphError([`Circular dependency detected among tasks: ${cyclic.join(', ')}.`]);
  }
  return ordered;
}
