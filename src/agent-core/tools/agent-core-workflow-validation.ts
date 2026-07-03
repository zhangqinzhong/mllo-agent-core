export type AgentCoreWorkflowValidationTask = {
  id: string
  dependsOn?: string[]
}

export function duplicateAgentCoreWorkflowTaskIds(
  tasks: readonly AgentCoreWorkflowValidationTask[]
): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) {
      duplicates.add(task.id)
    }
    seen.add(task.id)
  }
  return [...duplicates]
}

export function missingAgentCoreWorkflowDependencies(
  tasks: readonly AgentCoreWorkflowValidationTask[]
): string[] {
  const ids = new Set(tasks.map((task) => task.id))
  const missing = new Set<string>()
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        missing.add(`${task.id}->${dependency}`)
      }
    }
  }
  return [...missing]
}

export function cyclicAgentCoreWorkflowDependencies(
  tasks: readonly AgentCoreWorkflowValidationTask[]
): string[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const cycles = new Set<string>()

  function visit(taskId: string, stack: readonly string[]): void {
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId)
      const cycle = [...stack.slice(cycleStart), taskId]
      cycles.add(cycle.join('->'))
      return
    }
    if (visited.has(taskId)) {
      return
    }
    const task = tasksById.get(taskId)
    if (task === undefined) {
      return
    }
    visiting.add(taskId)
    for (const dependency of task.dependsOn ?? []) {
      visit(dependency, [...stack, taskId])
    }
    visiting.delete(taskId)
    visited.add(taskId)
  }

  for (const task of tasks) {
    visit(task.id, [])
  }
  return [...cycles]
}

export function readyAgentCoreWorkflowTasks<T extends AgentCoreWorkflowValidationTask>(args: {
  tasks: readonly T[]
  completedIds: ReadonlySet<string>
  finishedIds: ReadonlySet<string>
}): T[] {
  return args.tasks.filter((task) => {
    if (args.finishedIds.has(task.id)) {
      return false
    }
    return (task.dependsOn ?? []).every((dependency) => args.completedIds.has(dependency))
  })
}

export function blockedAgentCoreWorkflowTasks<T extends AgentCoreWorkflowValidationTask>(args: {
  tasks: readonly T[]
  finishedIds: ReadonlySet<string>
}): T[] {
  return args.tasks.filter((task) => !args.finishedIds.has(task.id))
}
