import { checkAIUsageAllowance } from "../../entitlements/usage";
import { captureUsageContext } from "../../ai/usage/context";
import "server-only";
import { withAIUsageContext } from "../../ai/usage/context";
import { auth } from "../../auth/config";
import {
  AgentExecutor,
  AgentExecutionError,
  agentExecutionRequestSchema,
} from "../executor/executor";
import type { AgentRegistry } from "../registry";
import { AgentRouter, agentRoutingRequestSchema } from "../router/router";
import { failure, normalizeAgentFailure } from "./errors";
import type {
  AgentExecutionHandler,
  AgentRequestInput,
  AgentRequestResult,
  AgentServiceOptions,
} from "./types";

// Compose existing boundary schemas so limits and conversation support cannot drift.
const inputSchema = agentExecutionRequestSchema
  .omit({ agentId: true })
  .extend({
    request: agentRoutingRequestSchema.shape.request,
    preferredAgentId: agentRoutingRequestSchema.shape.preferredAgentId,
  })
  .strict();

/** One authenticated application request, coordinated through the existing components. */
export class AgentService<Extension extends string = never> {
  readonly #router: AgentRouter<Extension>;
  readonly #executor: AgentExecutor<Extension>;
  readonly #handlers: AgentServiceOptions<Extension>["handlers"];

  constructor(
    private readonly registry: AgentRegistry<Extension>,
    options: AgentServiceOptions<Extension> = {},
  ) {
    this.#router = new AgentRouter(registry, options.router);
    this.#executor = new AgentExecutor(registry, options.executor);
    this.#handlers = Object.freeze({ ...options.handlers }) as NonNullable<AgentServiceOptions<Extension>["handlers"]>;
  }

  async handleAgentRequest(
    input: AgentRequestInput,
    requestHeaders: Headers,
  ): Promise<AgentRequestResult<Extension>> {
    const started = performance.now();
    let stage: "authentication" | "routing" | "execution" = "authentication";
    try {
      // Freeze the credential values for this call, including across an async routing fallback.
      const trustedHeaders = new Headers(requestHeaders);
      const session = await auth().api.getSession({
        headers: trustedHeaders,
        query: { disableRefresh: true },
      });
      if (!session?.user.id) {
        return failure(
          "UNAUTHENTICATED",
          new AgentExecutionError("UNAUTHENTICATED").message,
        );
      }
      return await withAIUsageContext({ userId: session.user.id }, async () => {
        const parsed = inputSchema.safeParse(input);
        if (!parsed.success) {
          return failure(
            "INVALID_REQUEST",
            new AgentExecutionError("INVALID_REQUEST").message,
          );
        }
        await checkAIUsageAllowance(session.user.id, captureUsageContext({ agentId: parsed.data.preferredAgentId }));
        const { request, preferredAgentId, courseId, examId, assignmentId, projectIds, documentIds, conversation } =
          parsed.data;
        stage = "routing";
        const routing = await this.#router.routeAgent({
          request,
          ...(preferredAgentId !== undefined ? { preferredAgentId } : {}),
        });
        stage = "execution";
        // Executor/Context Builder derive the same verified user from the captured session.
        const handler: AgentExecutionHandler<Extension> = this.#handlers?.[routing.agentId] ??
          ((request, headers, executor) => executor.execute(request, headers));
        const execution = await handler(
          {
            agentId: routing.agentId,
            request,
            ...(courseId !== undefined ? { courseId } : {}),
            ...(examId !== undefined ? { examId } : {}),
            ...(assignmentId !== undefined ? { assignmentId } : {}),
            ...(projectIds !== undefined ? { projectIds } : {}),
            ...(documentIds !== undefined ? { documentIds } : {}),
            ...(conversation !== undefined ? { conversation } : {}),
          },
          trustedHeaders,
          this.#executor,
          this.registry,
        );
        const agent = this.registry.get(execution.agentId);
        return {
          ok: true,
          agent: { id: agent.id, name: agent.name },
          routing: {
            agentId: routing.agentId,
            confidence: routing.confidence,
            method: routing.method,
          },
          response: {
            content: execution.content,
            sources: execution.sources ?? [],
            ...(execution.structuredData !== undefined ? { structuredData: execution.structuredData } : {}),
          },
          metadata: {
            ...execution.metadata,
            totalDurationMs: Math.round(performance.now() - started),
          },
        };
      });
    } catch (error) {
      return normalizeAgentFailure(error, stage);
    }
  }
}
