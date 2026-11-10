import { ADVISORY_ROLES, AgentRole, AgentStatus, ColonyMember, ColonyAgentCapabilities } from '../types.js';

/**
 * Why `member` cannot take a task that asks for `needs`, or null when it can. The single source of
 * eligibility: `findCandidates` filters with it and the scoring explains with it, so the two
 * cannot drift apart.
 */
export function ineligibleReason(needs: { requiredRole?: AgentRole; requiredCapabilities?: readonly string[] }, member: ColonyMember): string | null {
  if (member.status === 'offline' || member.status === 'error') return `member is ${member.status}`;
  if (needs.requiredRole && member.role !== needs.requiredRole) return `role is ${member.role}, the task needs ${needs.requiredRole}`;
  if (!needs.requiredRole && ADVISORY_ROLES.includes(member.role)) return `${member.role} only takes a task that asks for that role`;
  if (member.currentTaskIds.length >= member.capabilities.maxConcurrentTasks) return 'member is at capacity';
  const missing = (needs.requiredCapabilities ?? []).filter((c) => !member.capabilities.tools.includes(c) && !member.capabilities.specializations?.includes(c));
  if (missing.length > 0) return `missing capabilities: ${missing.join(', ')}`;
  return null;
}

export interface RegisterMemberOptions {
  id?: string;
  name: string;
  role: AgentRole;
  capabilities?: Partial<ColonyAgentCapabilities>;
  metadata?: Record<string, unknown>;
}

/**
 * Registry for tracking Colony members, their roles, capacities, and active states
 */
export class ColonyRegistry {
  private members = new Map<string, ColonyMember>();

  public register(options: RegisterMemberOptions): ColonyMember {
    const id = options.id || `agent_${options.role}_${Math.random().toString(36).substring(2, 8)}`;

    if (this.members.has(id)) {
      throw new Error(`Member with id '${id}' already registered in colony`);
    }

    const defaultCapabilities: ColonyAgentCapabilities = {
      tools: [],
      maxConcurrentTasks: 1,
      languages: ['typescript', 'javascript', 'python'],
      specializations: [],
      contextWindowLimit: 128000,
    };

    const member: ColonyMember = {
      id,
      name: options.name,
      role: options.role,
      status: 'idle',
      capabilities: { ...defaultCapabilities, ...options.capabilities },
      currentTaskIds: [],
      metadata: options.metadata || {},
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.members.set(id, member);
    return member;
  }

  public unregister(id: string): boolean {
    const member = this.members.get(id);
    if (member && member.currentTaskIds.length > 0) {
      throw new Error(`Member '${id}' still holds ${member.currentTaskIds.length} open task(s): hand them over first`);
    }
    return this.members.delete(id);
  }

  public getMember(id: string): ColonyMember | undefined {
    return this.members.get(id);
  }

  public getAllMembers(): ColonyMember[] {
    return Array.from(this.members.values());
  }

  public snapshot(): ColonyMember[] {
    return structuredClone(this.getAllMembers());
  }

  public restore(members: ColonyMember[]): void {
    this.members.clear();
    for (const member of structuredClone(members)) {
      this.members.set(member.id, member);
    }
  }

  public updateStatus(id: string, status: AgentStatus): void {
    const member = this.members.get(id);
    if (!member) throw new Error(`Member '${id}' not found`);
    member.status = status;
    member.lastActiveAt = Date.now();
  }

  public assignTask(agentId: string, taskId: string): void {
    const member = this.members.get(agentId);
    if (!member) throw new Error(`Member '${agentId}' not found`);

    if (!member.currentTaskIds.includes(taskId)) {
      member.currentTaskIds.push(taskId);
    }
    // An offline or failed member stays that way: taking a task does not bring it back.
    if (member.status !== 'offline' && member.status !== 'error') {
      member.status = member.currentTaskIds.length >= member.capabilities.maxConcurrentTasks ? 'busy' : 'idle';
    }
    member.lastActiveAt = Date.now();
  }

  public completeTask(agentId: string, taskId: string): void {
    const member = this.members.get(agentId);
    if (!member) return;

    member.currentTaskIds = member.currentTaskIds.filter((id) => id !== taskId);
    if (member.status !== 'offline' && member.status !== 'error') {
      member.status = member.currentTaskIds.length === 0 ? 'idle' : 'busy';
    }
    member.lastActiveAt = Date.now();
  }

  /**
   * Find the best candidates for a task based on role, capabilities, and availability
   */
  public findCandidates(requirements: {
    role?: AgentRole;
    requiredCapabilities?: string[];
  }): ColonyMember[] {
    return this.getAllMembers()
      .filter((member) => ineligibleReason({ requiredRole: requirements.role, requiredCapabilities: requirements.requiredCapabilities }, member) === null)
      .sort((a, b) => a.currentTaskIds.length - b.currentTaskIds.length); // Least busy first
  }
}
