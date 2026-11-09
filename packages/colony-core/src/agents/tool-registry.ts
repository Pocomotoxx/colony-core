import { z } from 'zod';

export interface ColonyToolExecutionContext {
  agentId: string;
  taskId?: string;
  extra?: Record<string, unknown>;
}

export interface ColonyTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  execute(params: TInput, context: ColonyToolExecutionContext): Promise<TOutput>;
}

/**
 * Registry for Colony tools and MCP integration
 */
export class ColonyToolRegistry {
  private tools = new Map<string, ColonyTool>();

  public register<TInput, TOutput>(tool: ColonyTool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): ColonyTool | undefined {
    return this.tools.get(name);
  }

  public listTools(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  public async execute(
    toolName: string,
    params: unknown,
    context: ColonyToolExecutionContext
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found in registry`);
    }

    const validated = tool.parameters.parse(params);
    return tool.execute(validated, context);
  }
}
