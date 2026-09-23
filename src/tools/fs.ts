import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fail, ok, type Tool } from './types.ts';

const execFileAsync = promisify(execFile);

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.harness-demo']);

function within(cwd: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the thread cwd: ${path}`);
  }
  return abs;
}

export const listFiles: Tool = {
  name: 'list_files',
  category: 'read',
  description: 'List files under a directory, relative to the thread cwd.',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Directory to list. Defaults to the thread cwd.' },
      depth: { type: 'number', description: 'How many levels deep to descend. Default 2.' },
    },
  },
  async run(input, ctx) {
    const dir = within(ctx.cwd, String(input.dir ?? '.'));
    const maxDepth = Number(input.depth ?? 2);
    const out: string[] = [];

    const walk = (current: string, depth: number): void => {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
        if (IGNORED.has(entry.name)) continue;
        const full = join(current, entry.name);
        const rel = relative(ctx.cwd, full) || '.';
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          walk(full, depth + 1);
        } else {
          out.push(`${rel} (${statSync(full).size}b)`);
        }
      }
    };

    walk(dir, 1);
    return ok(out.length ? out.join('\n') : '(empty)');
  },
};

export const readFile: Tool = {
  name: 'read_file',
  category: 'read',
  description: 'Read a UTF-8 text file, relative to the thread cwd.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, maxBytes: { type: 'number' } },
    required: ['path'],
  },
  async run(input, ctx) {
    const path = within(ctx.cwd, String(input.path));
    const maxBytes = Number(input.maxBytes ?? 8_000);
    try {
      const raw = readFileSync(path, 'utf8');
      return ok(raw.length > maxBytes ? `${raw.slice(0, maxBytes)}\n…[truncated]` : raw);
    } catch (error) {
      return fail(`could not read ${input.path}: ${(error as Error).message}`);
    }
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  category: 'write',
  description: 'Write a UTF-8 text file, relative to the thread cwd. Creates parent directories.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async run(input, ctx) {
    try {
      const path = within(ctx.cwd, String(input.path));
      const content = String(input.content ?? '');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
      return ok(`wrote ${relative(ctx.cwd, path)} (${Buffer.byteLength(content)} bytes)`);
    } catch (error) {
      return fail(`write failed: ${(error as Error).message}`);
    }
  },
};

export const runCommand: Tool = {
  name: 'run_command',
  category: 'exec',
  description: 'Run a shell command in the thread cwd.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  async run(input, ctx) {
    const command = String(input.command ?? '');
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return ok([stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)');
    } catch (error) {
      return fail(`command failed: ${(error as Error).message}`);
    }
  },
};
