import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { z } from "zod";
import { Logger } from "../utils/logger.js";
import {
  inflightRequests,
  piiDetectionsTotal,
  piiScanTruncatedTotal,
  toolCallsTotal,
  toolDurationSeconds,
} from "../obs/metrics.js";
import type { AuditEvent } from "../privacy/audit.js";
import { detectPii } from "../privacy/detect.js";
import { evaluatePolicy } from "../privacy/policy.js";

export interface AppDeps {
  // Populated per phase: httpClient (Ph1), ladder (Ph2), searchFanout (Ph3),
  // reranker (Ph4), stores (Ph6). Empty object is the default for Phase 0.
  audit?: (event: AuditEvent) => void;
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
        // PII scan on tool arguments (capped at 8 KB — tool inputs are unbounded z.string())
        const argsJson = JSON.stringify(args);
        const truncated = argsJson.length > 8192;
        if (truncated) piiScanTruncatedTotal.inc({ tool: def.name });
        const piiClasses = detectPii(truncated ? argsJson.slice(0, 8192) : argsJson);
        const policy = evaluatePolicy(piiClasses);
        for (const cls of piiClasses) {
          piiDetectionsTotal.inc({ class: cls, action: policy.action });
        }

        inflightRequests.inc();
        const timer = toolDurationSeconds.startTimer({ tool: def.name });
        try {
          if (policy.action === 'block') {
            toolCallsTotal.inc({ tool: def.name, outcome: 'error' });
            deps.audit?.({
              requestId,
              tool: def.name,
              timestamp: Date.now(),
              outcome: 'blocked',
              piiClasses,
              action: 'blocked',
            });
            return {
              content: [{ type: 'text' as const, text: `# Blocked\n\nThis request was blocked: POPIA enforcement detected ${piiClasses.join(', ')} in the tool arguments.\n` }],
              isError: true,
            };
          }

          const result = await def.handler(args as never, ctx);
          toolCallsTotal.inc({ tool: def.name, outcome: "success" });
          deps.audit?.({
            requestId,
            tool: def.name,
            timestamp: Date.now(),
            outcome: 'success',
            piiClasses,
            action: policy.action === 'audit' ? 'audited' : 'logged',
          });
          return {
            content: [{ type: "text" as const, text: def.toText(result) }],
            structuredContent: result,
          };
        } catch (error) {
          toolCallsTotal.inc({ tool: def.name, outcome: "error" });
          deps.audit?.({
            requestId,
            tool: def.name,
            timestamp: Date.now(),
            outcome: 'error',
            piiClasses,
            action: 'logged',
          });
          const msg = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [{ type: "text" as const, text: `# Error\n\n${msg}\n` }],
            isError: true,
          };
        } finally {
          timer();
          inflightRequests.dec();
        }
      },
    );
  }
}
