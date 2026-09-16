import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  AgentRegistry,
  getStudentAgentDefinitions,
  type AgentId,
} from "../server/agents";
import {
  AgentRouter,
  AgentRoutingError,
  type AgentRoutingRequest,
  type AgentRoutingResult,
} from "../server/agents/router";
import type { AIProvider, AIStructuredRequest } from "../server/ai/types";

function registry(): AgentRegistry {
  const result = new AgentRegistry();
  for (const agent of getStudentAgentDefinitions()) result.register(agent);
  return result;
}

// Only the AIProvider structured-output boundary is mocked; registry/routing are real.
function fallback(data: unknown = { agentId: "tutor", confidence: 0.75 }) {
  const generate = vi.fn(
    async (input: AIStructuredRequest<unknown>): Promise<unknown> => {
      void input;
      return data;
    },
  );
  const provider: AIProvider = {
    async generateStructuredOutput<T>(input: AIStructuredRequest<T>) {
      return {
        id: "routing-test",
        model: "mock-provider",
        text: "",
        // Deliberately permit malformed data to verify defensive router validation.
        data: (await generate(input)) as T,
      };
    },
    generateText() {
      throw new Error("Router must not generate an answer.");
    },
    streamText() {
      throw new Error("Router must not stream an answer.");
    },
    generateEmbedding() {
      throw new Error("Router must not embed or retrieve.");
    },
  };
  const getProvider = vi.fn(() => provider);
  return { generate, getProvider };
}

describe("Agent Router deterministic layers", () => {
  it.each([
    ["Explain mathematical induction", "tutor"],
    ["Summarize lecture 5", "notes"],
    ["Quiz me on recursion", "quiz"],
    ["Create a study plan for my exam", "study-planner"],
    ["Help improve my resume", "career"],
    ["Help me prioritize my semester", "academic-manager"],
  ])(
    "routes %s to %s without initializing AIProvider",
    async (request, agentId) => {
      const ai = fallback();
      const router = new AgentRouter(registry(), ai);
      expect(await router.routeAgent({ request })).toMatchObject({
        agentId,
        method: "rule",
        confidence: 0.92,
      });
      expect(ai.getProvider).not.toHaveBeenCalled();
      expect(ai.generate).not.toHaveBeenCalled();
    },
  );

  it("handles capitalization/whitespace and avoids substring keyword matches", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), ai);
    expect(
      await router.routeAgent({
        request: "  HELP ME   UNDERSTAND induction  ",
      }),
    ).toMatchObject({ agentId: "tutor", method: "rule" });
    expect(
      await router.routeAgent({ request: "Consider careerism" }),
    ).toMatchObject({ method: "llm-fallback" });
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it("matches capability words from registry metadata before using AI", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), ai);
    expect(
      await router.routeAgent({ request: "Please evaluate my answers" }),
    ).toMatchObject({
      agentId: "quiz",
      method: "capability",
      confidence: 0.86,
    });
    expect(
      await router.routeAgent({
        request: "Please create notes from this material",
      }),
    ).toMatchObject({
      agentId: "notes",
      method: "capability",
      confidence: 0.86,
    });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("uses actual custom agent capabilities and supports registry extensions", async () => {
    const agents = new AgentRegistry<"custom-reviewer">();
    agents.register({
      id: "custom-reviewer",
      name: "Reviewer",
      description: "Evaluates practice answers.",
      capabilities: ["evaluate-answers"],
      contextRequirements: {},
    });
    const ai = fallback();
    const router = new AgentRouter(agents, ai);
    expect(
      await router.routeAgent({ request: "Evaluate my answer" }),
    ).toMatchObject({ agentId: "custom-reviewer", method: "capability" });
    expect(ai.getProvider).not.toHaveBeenCalled();
    expectTypeOf<
      AgentRoutingResult<"custom-reviewer">["agentId"]
    >().toEqualTypeOf<AgentId<"custom-reviewer">>();
  });

  it("observes newly registered agents on the next request", async () => {
    const agents = new AgentRegistry();
    const ai = fallback();
    const router = new AgentRouter(agents, ai);
    agents.register(
      getStudentAgentDefinitions().find((agent) => agent.id === "notes")!,
    );
    expect(
      await router.routeAgent({ request: "Summarize lecture 5" }),
    ).toMatchObject({ agentId: "notes", method: "rule" });
  });

  it("can accept a unique moderate capability match with a configured threshold", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), {
      ...ai,
      deterministicThreshold: 0.5,
    });
    expect(
      // Concepts now also match Notes; mistakes remain a unique Tutor capability.
      await router.routeAgent({ request: "Mistakes, please" }),
    ).toMatchObject({
      agentId: "tutor",
      method: "capability",
      confidence: 0.55,
    });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it.each([0.49, 1.01, Number.NaN])(
    "rejects invalid threshold %s",
    (deterministicThreshold) => {
      expect(
        () => new AgentRouter(registry(), { deterministicThreshold }),
      ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
    },
  );
});

describe("explicit selection and availability", () => {
  it("honors a valid explicit selection over request hints without AI", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), ai);
    expect(
      await router.routeAgent({
        request: "Quiz me on recursion",
        preferredAgentId: "tutor",
      }),
    ).toMatchObject({
      agentId: "tutor",
      confidence: 1,
      method: "rule",
      reason: "Explicit agent selection.",
    });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("rejects an unknown explicit ID without silently defaulting", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), ai);
    await expect(
      router.routeAgent({
        request: "Help me with school",
        preferredAgentId: "tutr",
      }),
    ).rejects.toMatchObject({
      name: "AgentRoutingError",
      code: "UNKNOWN_AGENT",
    });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("rejects a registered but disallowed explicit selection", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), {
      ...ai,
      allowedAgentIds: ["notes", "academic-manager"],
    });
    await expect(
      router.routeAgent({
        request: "Something useful",
        preferredAgentId: "tutor",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ALLOWED" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("filters rules, capabilities, fallback schema, and default by the same allowlist", async () => {
    const ai = fallback({ agentId: "tutor", confidence: 0.99 });
    const router = new AgentRouter(registry(), {
      ...ai,
      allowedAgentIds: ["notes", "academic-manager"],
    });
    expect(
      await router.routeAgent({ request: "Explain concepts" }),
    ).toMatchObject({ agentId: "academic-manager", method: "default" });
    const input = ai.generate.mock.calls[0][0];
    expect(
      input.schema.safeParse({ agentId: "tutor", confidence: 0.99 }).success,
    ).toBe(false);
    expect(input.messages[0].content).not.toContain('"id":"tutor"');
    expect(input.messages[0].content).toContain('"id":"notes"');
  });

  it("copies caller allowlists so later mutations do not broaden access", async () => {
    const allowedAgentIds: AgentId[] = ["notes"];
    const router = new AgentRouter(registry(), {
      ...fallback(),
      allowedAgentIds,
    });
    allowedAgentIds.push("tutor");
    await expect(
      router.routeAgent({
        request: "Explain induction",
        preferredAgentId: "tutor",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ALLOWED" });
  });

  it("handles an empty registry and an empty allowlist without AI", async () => {
    const ai = fallback();
    for (const router of [
      new AgentRouter(new AgentRegistry(), ai),
      new AgentRouter(registry(), { ...ai, allowedAgentIds: [] }),
    ]) {
      await expect(
        router.routeAgent({ request: "Explain induction" }),
      ).rejects.toMatchObject({ code: "NO_AVAILABLE_AGENTS" });
    }
    expect(ai.getProvider).not.toHaveBeenCalled();
  });

  it("rejects unknown allowlist entries as server configuration errors", () => {
    expect(
      () =>
        new AgentRouter(new AgentRegistry(), { allowedAgentIds: ["tutor"] }),
    ).toThrow(AgentRoutingError);
  });
});

describe("AIProvider structured-output fallback", () => {
  it.each([
    "I need some help with this",
    "Concepts, please",
    "Prioritize deadlines",
    "Explain induction and quiz me on it",
  ])(
    "uses fallback for uncertain or conflicting request: %s",
    async (request) => {
      const ai = fallback({ agentId: "tutor", confidence: 0.72 });
      const router = new AgentRouter(registry(), ai);
      expect(await router.routeAgent({ request })).toMatchObject({
        agentId: "tutor",
        confidence: 0.72,
        method: "llm-fallback",
      });
      expect(ai.getProvider).toHaveBeenCalledTimes(1);
      expect(ai.generate).toHaveBeenCalledTimes(1);
    },
  );

  it("sends only a bounded request and concise metadata, with a restricted schema", async () => {
    const ai = fallback();
    const router = new AgentRouter(registry(), ai);
    await router.routeAgent({ request: "  I need some help with this  " });
    const input = ai.generate.mock.calls[0][0];
    expect(input.maxOutputTokens).toBe(128);
    expect(input.model).toBeUndefined();
    expect(input.messages).toHaveLength(2);
    expect(input.messages[1]).toEqual({
      role: "user",
      content: "I need some help with this",
    });
    const metadata = JSON.parse(
      input.messages[0].content.split("\nAgents: ")[1],
    ) as Record<string, unknown>[];
    expect(metadata).toHaveLength(6);
    for (const agent of metadata)
      expect(Object.keys(agent).sort()).toEqual([
        "capabilities",
        "description",
        "id",
      ]);
    expect(input.messages[0].content.length).toBeLessThan(2000);
    expect(
      input.schema.safeParse({ agentId: "tutor", confidence: 0.8 }).success,
    ).toBe(true);
    expect(
      input.schema.safeParse({ agentId: "not-registered", confidence: 0.8 })
        .success,
    ).toBe(false);
  });

  it.each([
    { agentId: "not-registered", confidence: 0.9 },
    { agentId: "tutor", confidence: -0.1 },
    { agentId: "tutor", confidence: 1.1 },
    { agentId: "tutor", confidence: Number.NaN },
    { agentId: "tutor", confidence: "0.9" },
    { agentId: "tutor" },
    { agentId: "tutor", confidence: 0.9, reason: "Extra output" },
    null,
    undefined,
    [],
  ])(
    "rejects invalid fallback data %# and uses the registered default",
    async (invalid) => {
      const ai = fallback(null);
      ai.generate.mockResolvedValue(invalid);
      const router = new AgentRouter(registry(), ai);
      expect(
        await router.routeAgent({ request: "Something useful" }),
      ).toMatchObject({
        agentId: "academic-manager",
        confidence: 0.25,
        method: "default",
      });
    },
  );

  it("rejects low-confidence model selection but accepts the 0.5 boundary", async () => {
    const ai = fallback({ agentId: "tutor", confidence: 0.49 });
    const router = new AgentRouter(registry(), ai);
    expect(
      (await router.routeAgent({ request: "Something useful" })).method,
    ).toBe("default");
    ai.generate.mockResolvedValue({ agentId: "tutor", confidence: 0.5 });
    expect(
      await router.routeAgent({ request: "Something useful" }),
    ).toMatchObject({
      agentId: "tutor",
      confidence: 0.5,
      method: "llm-fallback",
    });
  });

  it("handles provider failures without leaking errors or retrying", async () => {
    const ai = fallback();
    ai.generate.mockRejectedValue(new Error("Raw provider error with secret"));
    const router = new AgentRouter(registry(), ai);
    const result = await router.routeAgent({ request: "Something useful" });
    expect(result).toMatchObject({
      agentId: "academic-manager",
      method: "default",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(ai.generate).toHaveBeenCalledTimes(1);
  });

  it("uses the default if the lazy provider factory cannot initialize", async () => {
    const getProvider = vi.fn((): AIProvider => {
      throw new Error("Missing configuration");
    });
    const router = new AgentRouter(registry(), { getProvider });
    expect(
      (await router.routeAgent({ request: "Explain induction" })).method,
    ).toBe("rule");
    expect(getProvider).not.toHaveBeenCalled();
    expect(
      (await router.routeAgent({ request: "Something useful" })).method,
    ).toBe("default");
    expect(getProvider).toHaveBeenCalledTimes(1);
  });

  it("never returns an unavailable default or an arbitrary specialist", async () => {
    const agents = new AgentRegistry();
    agents.register(
      getStudentAgentDefinitions().find((agent) => agent.id === "notes")!,
    );
    const router = new AgentRouter(agents, fallback(null));
    await expect(
      router.routeAgent({ request: "Something useful" }),
    ).rejects.toMatchObject({ code: "DEFAULT_UNAVAILABLE" });
    const restricted = new AgentRouter(registry(), {
      ...fallback(null),
      allowedAgentIds: ["notes"],
    });
    await expect(
      restricted.routeAgent({ request: "Something useful" }),
    ).rejects.toMatchObject({ code: "DEFAULT_UNAVAILABLE" });
  });

  it("supports an explicitly configured default and extension IDs in fallback", async () => {
    const agents = new AgentRegistry<"custom-agent">();
    agents.register({
      id: "custom-agent",
      name: "Custom",
      description: "Metadata only.",
      capabilities: [],
      contextRequirements: {},
    });
    const ai = fallback({ agentId: "custom-agent", confidence: 0.8 });
    const router = new AgentRouter(agents, {
      ...ai,
      defaultAgentId: "custom-agent",
    });
    expect(
      await router.routeAgent({ request: "Something useful" }),
    ).toMatchObject({ agentId: "custom-agent", method: "llm-fallback" });
    ai.generate.mockResolvedValue(null);
    expect(
      await router.routeAgent({ request: "Something useful" }),
    ).toMatchObject({ agentId: "custom-agent", method: "default" });
  });

  it("skips oversized metadata instead of making a large call or dropping agents", async () => {
    const agents = new AgentRegistry<`custom-${number}`>();
    agents.register(getStudentAgentDefinitions()[0]);
    for (let i = 0; i < 40; i++) {
      agents.register({
        id: `custom-${i}`,
        name: "Custom",
        description: "x".repeat(400),
        capabilities: [],
        contextRequirements: {},
      });
    }
    const ai = fallback();
    const router = new AgentRouter(agents, ai);
    expect(
      await router.routeAgent({ request: "Something useful" }),
    ).toMatchObject({ agentId: "academic-manager", method: "default" });
    expect(ai.getProvider).not.toHaveBeenCalled();
  });
});

describe("routing input boundary", () => {
  it.each([
    { request: "" },
    { request: "   " },
    { request: "x".repeat(4001) },
    { request: "Something useful", preferredAgentId: "" },
    {
      request: "Something useful",
      context: { documents: ["PRIVATE DOCUMENT"] },
    },
    {
      request: "Something useful",
      conversation: [{ content: "PRIVATE HISTORY" }],
    },
    { request: "Something useful", allowedAgentIds: ["tutor"] },
  ])(
    "rejects invalid or oversized input %# before any fallback",
    async (input) => {
      const ai = fallback();
      const router = new AgentRouter(registry(), ai);
      await expect(router.routeAgent(input)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(ai.getProvider).not.toHaveBeenCalled();
    },
  );

  it("keeps the public input independent of full UserContext", () => {
    expectTypeOf<keyof AgentRoutingRequest>().toEqualTypeOf<
      "request" | "preferredAgentId"
    >();
  });
});
