export type AgentRole =
  | "requirements"
  | "architect"
  | "database"
  | "backend"
  | "frontend"
  | "integrator"
  | "tester"
  | "fixer"
  | "documentation";

export interface AgentFileContext {
  path: string;
  content: string;
}

export interface AgentRunInput {
  role: AgentRole;
  instruction: string;
  files: AgentFileContext[];
  writableFiles: string[];
  validationCommand?: string;
}

export interface AgentRunResult {
  role: AgentRole;
  summary: string;
  changedFiles: string[];
  rawOutput: string;
}

export interface ModelProvider {
  generate(input: AgentRunInput): Promise<AgentRunResult>;
}

export class StubModelProvider implements ModelProvider {
  async generate(input: AgentRunInput): Promise<AgentRunResult> {
    return {
      role: input.role,
      summary: `Stubbed ${input.role} run`,
      changedFiles: [],
      rawOutput: JSON.stringify({
        role: input.role,
        filesReceived: input.files.map((file) => file.path),
        writableFiles: input.writableFiles,
        validationCommand: input.validationCommand ?? null
      })
    };
  }
}
