import type { ColonyMember } from './types.js';

/**
 * Colony topology: who is connected to whom. Pure and deterministic: the same members always give the
 * same graph (no randomness, no timers, no event emitter).
 *
 * Replaces the legacy swarm topology manager, which rebalanced randomly on a timer.
 */

export type TopologyType = 'mesh' | 'star' | 'tree' | 'hybrid';

export const TOPOLOGY_TYPES: readonly TopologyType[] = ['mesh', 'star', 'tree', 'hybrid'];

export interface TopologyOptions {
  /** Preferred leader; used only if it is an active member. */
  leaderId?: string;
  /** Mesh: connections per node (ring lattice), default 4. */
  meshDegree?: number;
  /** Tree: children per node, default 3. */
  fanout?: number;
}

export interface Topology {
  type: TopologyType;
  leader: string | undefined;
  nodes: string[]; // election order: leader first
  edges: Array<[string, string]>; // undirected, each pair once, sorted
}

const ROLE_RANK: Record<string, number> = { director: 0, architect: 1 };

const isActive = (m: ColonyMember): boolean => m.status !== 'offline' && m.status !== 'error';

/** Active members in election order: the preferred leader, then director, architect, the rest; ties by id. */
export function electionOrder(members: ColonyMember[], leaderId?: string): ColonyMember[] {
  return members
    .filter(isActive)
    .sort(
      (a, b) =>
        Number(b.id === leaderId) - Number(a.id === leaderId) ||
        (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2) ||
        a.id.localeCompare(b.id)
    );
}

export function buildTopology(members: ColonyMember[], type: TopologyType, options: TopologyOptions = {}): Topology {
  const ordered = electionOrder(members, options.leaderId);
  const ids = ordered.map((m) => m.id);
  const n = ids.length;
  const pairs = new Map<string, [string, string]>();
  const connect = (a: string, b: string): void => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    pairs.set(`${x}\u0000${y}`, [x, y]);
  };

  // Ring lattice over `list`: each node links to the next ceil(degree / 2) nodes.
  const ring = (list: string[], degree: number): void => {
    const reach = Math.ceil(Math.min(degree, list.length - 1) / 2);
    for (let i = 0; i < list.length; i++) {
      for (let step = 1; step <= reach; step++) connect(list[i], list[(i + step) % list.length]);
    }
  };

  if (n > 1) {
    switch (type) {
      case 'mesh':
        ring(ids, options.meshDegree ?? 4);
        break;
      case 'star':
        for (const id of ids.slice(1)) connect(ids[0], id);
        break;
      case 'tree': {
        const fanout = Math.max(1, options.fanout ?? 3);
        for (let i = 1; i < n; i++) connect(ids[Math.floor((i - 1) / fanout)], ids[i]);
        break;
      }
      case 'hybrid':
        for (const id of ids.slice(1)) connect(ids[0], id);
        ring(ids.slice(1), 2);
        break;
    }
  }

  const edges = Array.from(pairs.values()).sort((p, q) => p[0].localeCompare(q[0]) || p[1].localeCompare(q[1]));
  return { type, leader: ids[0], nodes: ids, edges };
}

export function neighbors(topology: Topology, id: string): string[] {
  const out: string[] = [];
  for (const [a, b] of topology.edges) {
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out.sort();
}

/** Shortest path by hop count (breadth first, ties broken by id). Empty when there is no path. */
export function shortestPath(topology: Topology, from: string, to: string): string[] {
  if (!topology.nodes.includes(from) || !topology.nodes.includes(to)) return [];
  if (from === to) return [from];
  const previous = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of neighbors(topology, current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const path = [to];
        while (path[0] !== from) path.unshift(previous.get(path[0])!);
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

export function isFullyConnected(topology: Topology): boolean {
  if (topology.nodes.length <= 1) return true;
  return topology.nodes.every((id) => shortestPath(topology, topology.nodes[0], id).length > 0);
}
