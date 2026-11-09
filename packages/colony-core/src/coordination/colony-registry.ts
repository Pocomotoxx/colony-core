import { ADVISORY_ROLES, AgentRole, AgentStatus, ColonyMember, ColonyAgentCapabilities } from '../types.js';

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
    member.status = member.currentTaskIds.length >= member.capabilities.maxConcurrentTasks ? 'busy' : 'idle';
    member.lastActiveAt = Date.now();
  }

  public completeTask(agentId: string, taskId: string): void {
    const member = this.members.get(agentId);
    if (!member) return;

    member.currentTaskIds = member.currentTaskIds.filter((id) => id !== taskId);
    member.status = member.currentTaskIds.length === 0 ? 'idle' : 'busy';
    member.lastActiveAt = Date.now();
  }

  /**
   * Find the best candidates for a task based on role, capabilities, and availability
   */
  public findCandidates(requirements: {
    role?: AgentRole;
    requiredCapabilities?: string[];
  }): ColonyMember[] {
    return this.getAllMembers().filter((member) => {
      // Must not be in error or offline status
      if (member.status === 'offline' || member.status === 'error') {
        return false;
      }

      // Check role if specified
      if (requirements.role && member.role !== requirements.role) {
        return false;
      }

      // Advisory roles are never an implicit candidate: the task has to ask for them
      if (!requirements.role && ADVISORY_ROLES.includes(member.role)) {
        return false;
      }

      // Check capacity
      if (member.currentTaskIds.length >= member.capabilities.maxConcurrentTasks) {
        return false;
      }

      // Check specific tools/capabilities if requested
      if (requirements.requiredCapabilities && requirements.requiredCapabilities.length > 0) {
        const hasAllCapabilities = requirements.requiredCapabilities.every((cap) =>
          member.capabilities.tools.includes(cap) ||
          member.capabilities.specializations?.includes(cap)
        );
        if (!hasAllCapabilities) return false;
      }

      return true;
    }).sort((a, b) => a.currentTaskIds.length - b.currentTaskIds.length); // Least busy first
  }
}
