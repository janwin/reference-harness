import { isAbsolute, relative, resolve } from 'node:path';

import type { Grant, Mode, PermissionEffect } from '../core/events.ts';

export type ToolCategory = 'read' | 'write' | 'exec' | 'human' | 'meta' | 'network';

export interface PermissionRequest {
  tool: string;
  category: ToolCategory;
  input: Record<string, unknown>;
  mode: Mode;
  cwd: string;
  grants: Grant[];
  yolo: boolean;
  /** Tools the operator hard-denied for this session (`--deny write_file`). */
  deniedTools: string[];
}

export interface Decision {
  effect: PermissionEffect;
  rule: string;
  reason: string;
}

export interface Rule {
  name: string;
  /** Return a decision to stop the chain, or null to defer to the next rule. */
  evaluate(req: PermissionRequest): Decision | null;
}

export interface ChainResult extends Decision {
  /** Every rule consulted and what it said — the reason this is auditable. */
  trace: Array<{ rule: string; result: Decision | null }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The path or command a request is "about", for scope matching. */
export function subjectOf(req: PermissionRequest): string {
  if (req.category === 'exec') return str(req.input.command);
  const path = str(req.input.path) || str(req.input.dir);
  if (!path) return '';
  return isAbsolute(path) ? path : resolve(req.cwd, path);
}

const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: 'recursive/forced delete' },
  { pattern: /\bsudo\b/i, why: 'privilege escalation' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i, why: 'pipe-to-shell' },
  { pattern: /\bmkfs\b|\bdd\s+if=/i, why: 'disk-destructive command' },
  { pattern: /\bgit\s+push\b[^\n]*--force\b/i, why: 'force push' },
  { pattern: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, why: 'host control' },
];

/**
 * RULE 1 — hard denies. Nothing later in the chain can override these, not even
 * YOLO. If a harness has one non-negotiable layer, it is this one.
 */
export const denyRules: Rule = {
  name: 'deny-rules',
  evaluate(req) {
    if (req.deniedTools.includes(req.tool)) {
      return { effect: 'deny', rule: 'deny-rules', reason: `tool '${req.tool}' is denied for this session` };
    }

    const subject = subjectOf(req);

    if (req.category === 'exec') {
      for (const { pattern, why } of DANGEROUS_COMMANDS) {
        if (pattern.test(subject)) {
          return { effect: 'deny', rule: 'deny-rules', reason: `blocked ${why}` };
        }
      }
    }

    if (req.category === 'write' && subject) {
      const rel = relative(req.cwd, subject);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { effect: 'deny', rule: 'deny-rules', reason: 'write outside the thread cwd' };
      }
      if (rel.split('/').includes('.git')) {
        return { effect: 'deny', rule: 'deny-rules', reason: 'writes into .git/ are never allowed' };
      }
    }

    return null;
  },
};

/**
 * RULE 2 — plan mode is read-only, enforced rather than merely promised.
 *
 * This sits above YOLO and above session grants deliberately: "read-only" is
 * worth nothing if a flag from an hour ago can quietly undo it.
 */
export const modePolicy: Rule = {
  name: 'mode-policy',
  evaluate(req) {
    if (req.mode !== 'plan') return null;
    if (req.category === 'write' || req.category === 'exec') {
      return {
        effect: 'deny',
        rule: 'mode-policy',
        reason: 'plan mode is read-only — approve the plan to switch to build',
      };
    }
    return null;
  },
};

/** RULE 3 — the operator opted out of prompts entirely. */
export const yoloRule: Rule = {
  name: 'yolo',
  evaluate(req) {
    if (!req.yolo) return null;
    return { effect: 'allow', rule: 'yolo', reason: '--yolo: prompts disabled for this session' };
  },
};

export function grantMatches(grant: Grant, req: PermissionRequest): boolean {
  if (grant.tool !== req.tool) return false;
  if (grant.scope === '*') return true;
  const subject = subjectOf(req);
  return subject.startsWith(grant.scope);
}

/** RULE 4 — "always allow" answers the human already gave, replayed from the log. */
export const sessionGrants: Rule = {
  name: 'session-grants',
  evaluate(req) {
    const grant = req.grants.find((g) => grantMatches(g, req));
    if (!grant) return null;
    return {
      effect: 'allow',
      rule: 'session-grants',
      reason: `granted earlier: ${grant.tool} @ ${grant.scope}`,
    };
  },
};

const CATEGORY_DEFAULTS: Record<ToolCategory, PermissionEffect> = {
  read: 'allow',
  meta: 'allow',
  human: 'allow',
  write: 'ask',
  exec: 'ask',
  network: 'deny',
};

/** RULE 5 — the blanket policy for each kind of side effect. */

export const categoryPolicy: Rule = {
  name: 'category-policy',
  evaluate(req) {
    const effect = CATEGORY_DEFAULTS[req.category];
    if (effect === 'ask') return null; // let the fallback own the prompt wording
    return {
      effect,
      rule: 'category-policy',
      reason: `category '${req.category}' defaults to ${effect}`,
    };
  },
};

/** RULE 6 — anything unresolved reaches a human. The default is never "just do it". */
export const askFallback: Rule = {
  name: 'ask-fallback',
  evaluate(req) {
    return {
      effect: 'ask',
      rule: 'ask-fallback',
      reason: `no rule settled '${req.tool}' — asking the human`,
    };
  },
};

export const DEFAULT_CHAIN: Rule[] = [
  denyRules,
  modePolicy,
  yoloRule,
  sessionGrants,
  categoryPolicy,
  askFallback,
];

/**
 * Walk the chain in order; the first rule that returns a decision wins. The
 * whole trace comes back either way, so `harness explain` can show not just what
 * was decided but which rule decided it and what the others would have said.
 */
export function evaluate(req: PermissionRequest, chain: Rule[] = DEFAULT_CHAIN): ChainResult {
  const trace: ChainResult['trace'] = [];
  for (const rule of chain) {
    const result = rule.evaluate(req);
    trace.push({ rule: rule.name, result });
    if (result) return { ...result, trace };
  }
  return {
    effect: 'ask',
    rule: 'ask-fallback',
    reason: 'chain exhausted',
    trace,
  };
}

export function formatTrace(result: ChainResult): string {
  const lines = result.trace.map(({ rule, result: r }) => {
    if (!r) return `  · ${rule.padEnd(16)} → (defer)`;
    return `  ✓ ${rule.padEnd(16)} → ${r.effect.toUpperCase()}  ${r.reason}`;
  });
  return lines.join('\n');
}
