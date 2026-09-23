import { listFiles, readFile, runCommand, writeFile } from './fs.ts';
import { askUser, exitPlanMode } from './human.ts';
import { spawnSubagent } from './subagent.ts';
import { todoWrite } from './todos.ts';
import type { Tool } from './types.ts';

export const ALL_TOOLS: Tool[] = [
  listFiles,
  readFile,
  writeFile,
  runCommand,
  askUser,
  todoWrite,
  exitPlanMode,
  spawnSubagent,
];

export const READ_ONLY_TOOLS: Tool[] = ALL_TOOLS.filter(
  (t) => t.category === 'read' || t.category === 'meta',
);

export function toolByName(name: string, tools: Tool[] = ALL_TOOLS): Tool | undefined {
  return tools.find((t) => t.name === name);
}

/**
 * Which tools the model is even told about, given the mode.
 *
 * Plan mode hides the write tools rather than only denying them: a model that
 * never sees `write_file` does not waste a turn getting refused. The chain still
 * denies them if it tries, because visibility is a nicety and enforcement is not.
 */
export function toolsForMode(mode: 'plan' | 'build'): Tool[] {
  if (mode === 'build') return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => t.category !== 'write' && t.category !== 'exec');
}

export * from './types.ts';
