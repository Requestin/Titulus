// runtime/src/stackOrder.ts
//
// Flatten the template's group hierarchy + root/group stacks into a single
// paint order (DEVELOPMENT_PROMPT §6.2 groups, rootStack).
//
// The DOM `#stage` is a flat absolutely-positioned container; we control z-order
// with `z-index` per element. `rootStack` and each `groupStacks[gid]` list
// children back-to-front (last entry = frontmost). We walk the tree depth-first,
// assigning increasing z so that a parent's children stack above the parent's
// siblings per the stack arrays, and nested groups inherit their parent's place
// in the order.

import type { Template, RootStackEntry, LayerGroup } from './schema.js';

export interface FlatEntry {
  kind: 'layer' | 'group';
  id: string;
  /** depth in the group tree (0 = root) */
  depth: number;
  /** z-index to assign (monotonic increasing = frontward) */
  z: number;
  /** ancestor group ids from root down to (not including) this entry */
  ancestorGroups: string[];
}

/**
 * Compute the full paint order for a template. Returns entries in back-to-front
 * order with explicit z-index values starting at 1.
 */
export function computeStackOrder(template: Pick<Template, 'rootStack' | 'groupStacks' | 'groups'>): FlatEntry[] {
  const out: FlatEntry[] = [];
  let z = 1;

  const walk = (entries: RootStackEntry[] | undefined, depth: number, ancestors: string[]) => {
    if (!entries) return;
    for (const e of entries) {
      if (e.kind === 'group') {
        out.push({ kind: 'group', id: e.id, depth, z: z++, ancestorGroups: ancestors });
        // Recurse into the group's own stack. The group element itself is the
        // positioning context for its children (they're rendered inside it), so
        // children z is relative — but we still flatten globally to keep one
        // z-index space for hit-testing in the editor.
        walk(template.groupStacks[e.id], depth + 1, [...ancestors, e.id]);
      } else {
        out.push({ kind: 'layer', id: e.id, depth, z: z++, ancestorGroups: ancestors });
      }
    }
  };

  walk(template.rootStack, 0, []);
  return out;
}

/**
 * Find the group an element belongs to (its immediate parent), or null if it's
 * at the root.
 */
export function parentGroupOf(
  id: string,
  template: Pick<Template, 'rootStack' | 'groupStacks'>,
): string | null {
  // A layer's groupId field is authoritative; this is a fallback lookup from
  // the stacks for cases where the layer wasn't tagged.
  const search = (entries: RootStackEntry[] | undefined): boolean =>
    !!entries && entries.some((e) => e.id === id);
  if (search(template.rootStack)) return null;
  for (const [gid, entries] of Object.entries(template.groupStacks)) {
    if (search(entries)) return gid;
  }
  return null;
}

/** Map of groupId -> group object, for quick lookup while flattening/animating. */
export function groupMap(groups: LayerGroup[]): Record<string, LayerGroup> {
  const m: Record<string, LayerGroup> = {};
  for (const g of groups) m[g.id] = g;
  return m;
}
