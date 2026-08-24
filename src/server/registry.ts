import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { z } from "zod";
import { Logger } from "../utils/logger.js";

export interface AppDeps {
  // Populated per phase: httpClient (Ph1), ladder (Ph2), searchFanout (Ph3),
  // reranker (Ph4), stores (Ph6). Empty object is the default for Phase 0.
  [key: string]: unknown;
}

export interface ToolContext {
  requestId: string;
  signal: AbortSignal;
  logger: typeof Logger;
  deps: AppDeps;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/**
 * Typed descriptor for a single MCP tool.
 *
 * Both `outputSchema` and `toText` are REQUIRED — the registry invariant
 * test enforces this so the missing-schema gap cannot silently recur.
 */
export interface ToolDefinition<
  In extends ZodRawShape = ZodRawShape,
  Out extends ZodRawShape = ZodRawShape,
> {
  name: string;
  description: string;
  inputSchema: In;
  outputSchema: Out;
  annotations: ToolAnnotations;
  handler: (
    args: z.infer<z.ZodObject<In>>,
    ctx: ToolContext,
  ) => Promise<z.infer<z.ZodObject<Out>>>;
  toText: (result: z.infer<z.ZodObject<Out>>) => string;
}

/**
 * Register every tool definition with the MCP server.
 *
 * Each call gets its own requestId, AbortController, and ToolContext so
 * handlers are directly callable in tests via a fake ToolContext — no
 * transport boot required.
 */
export function registerAll(
  server: McpServer,
  deps: AppDeps,
  tools: ToolDefinition[],
): void {
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        annotations: def.annotations,
      },
      async (args: unknown) => {
        const requestId = Logger.generateRequestId();
        const controller = new AbortController();
        const ctx: ToolContext = {
          requestId,
          signal: controller.signal,
          logger: Logger,
          deps,
        };
        try {
          const result = await def.handler(args as never, ctx);
          return {
            content: [{ type: "text" as const, text: def.toText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [{ type: "text" as const, text: `# Error\n\n${msg}\n` }],
            isError: true,
          };
        }
      },
    );
  }
}
