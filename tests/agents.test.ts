import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AIUsage } from "../server/ai/types";
import type { ContextOptions, UserContext } from "../server/context/types";
import {
  AGENT_CAPABILITIES,
  AgentRegistry,
  AgentRegistryError,
  getStudentAgentDefinitions,
  STUDENT_AGENT_IDS,
  type Agent,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentId,
} from "../server/agents";

// Fail on runtime coupling, including through the public module entry point.
const boundaries = vi.hoisted(() => ({ ai: vi.fn(), context: vi.fn() }));
vi.mock("../server/ai", () => {
  boundaries.ai();
  throw new Error("The registry must not load AIProvider.");
});
vi.mock("../server/ai/providers/openai", () => {
  boundaries.ai();
  throw new Error("The registry must not load OpenAIProvider.");
});
vi.mock("openai", () => {
  boundaries.ai();
  throw new Error("The registry must not load the OpenAI SDK.");
});
vi.mock("../server/context", () => {
  boundaries.context();
  throw new Error("The registry must not load Context Builder.");
});
vi.mock("../server/context/builder", () => {
  boundaries.context();
  throw new Error("The registry must not build context.");
});

function tutor(): Agent {
  return {
    id: "tutor",
    name: "Tutor",
    description: "Explains concepts using course materials.",
    capabilities: ["explain-concepts", "answer-course-questions"],
    contextRequirements: { course: true, documents: true },
  };
}

function studentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  for (const agent of getStudentAgentDefinitions()) registry.register(agent);
  return registry;
}

describe("AgentRegistry", () => {
  it("starts empty without automatic registration", () => {
    const registry = new AgentRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.has("tutor")).toBe(false);
    expect(registry.getByCapability("explain-concepts")).toEqual([]);
  });

  it("registers, retrieves, and checks an agent", () => {
    const registry = new AgentRegistry();
    const agent = tutor();
    registry.register(agent);
    expect(registry.get("tutor")).toEqual(agent);
    expect(registry.get("tutor")).not.toBe(agent);
    expect(registry.has("tutor")).toBe(true);
    expect(registry.has("notes")).toBe(false);
  });

  it("lists exactly the registered metadata in registration order", () => {
    const registry = new AgentRegistry();
    registry.register(tutor());
    registry.register({ ...tutor(), id: "notes", name: "Notes" });
    expect(registry.list().map((agent) => agent.id)).toEqual([
      "tutor",
      "notes",
    ]);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("rejects duplicates with a typed error and preserves the original", () => {
    const registry = new AgentRegistry();
    registry.register(tutor());
    const duplicate = () =>
      registry.register({ ...tutor(), name: "Replacement" });
    expect(duplicate).toThrow(AgentRegistryError);
    expect(duplicate).toThrow(
      expect.objectContaining({
        code: "DUPLICATE_AGENT",
        agentId: "tutor",
      }),
    );
    expect(registry.get("tutor").name).toBe("Tutor");
    expect(registry.list()).toHaveLength(1);
  });

  it("reports unknown agents with a typed error without registering them", () => {
    const registry = new AgentRegistry();
    expect(() => registry.get("tutor")).toThrow(AgentRegistryError);
    expect(() => registry.get("tutor")).toThrow(
      expect.objectContaining({
        code: "AGENT_NOT_FOUND",
        agentId: "tutor",
        message: 'Agent "tutor" is not registered.',
      }),
    );
    expect(registry.list()).toEqual([]);
  });

  it("filters capability metadata without choosing an agent", () => {
    const registry = studentRegistry();
    expect(
      registry.getByCapability("prioritize-deadlines").map((agent) => agent.id),
    ).toEqual(["academic-manager", "study-planner"]);
    expect(
      registry.getByCapability("explain-concepts").map((agent) => agent.id),
    ).toEqual(["tutor"]);
    expect(Object.isFrozen(registry.getByCapability("explain-concepts"))).toBe(
      true,
    );
  });

  it("copies registration inputs without modifying or freezing caller data", () => {
    const capabilities: Agent["capabilities"][number][] = ["explain-concepts"];
    const options: ContextOptions = {
      profile: true,
      memories: true,
      memoryKeys: ["academicGoal"],
      limits: { documents: 2 },
    };
    const agent = { ...tutor(), capabilities, contextRequirements: options };
    const registry = new AgentRegistry();
    registry.register(agent);
    const stored = registry.get("tutor");

    expect(Object.isFrozen(agent)).toBe(false);
    expect(Object.isFrozen(capabilities)).toBe(false);
    expect(Object.isFrozen(options)).toBe(false);
    agent.id = "notes";
    agent.name = "Changed";
    capabilities.push("create-notes");
    options.profile = false;
    options.memoryKeys!.push("explanationStyle");
    options.limits!.documents = 9;
    expect(registry.get("tutor")).toEqual(stored);
    expect(registry.has("notes")).toBe(false);
  });

  it("protects stored metadata through get, list, and capability results", () => {
    const registry = new AgentRegistry();
    registry.register({
      ...tutor(),
      contextRequirements: {
        memories: true,
        memoryKeys: ["academicGoal"],
        limits: { documents: 2 },
      },
    });
    for (const result of [
      registry.get("tutor"),
      registry.list()[0],
      registry.getByCapability("explain-concepts")[0],
    ]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.capabilities)).toBe(true);
      expect(Object.isFrozen(result.contextRequirements)).toBe(true);
      // Nested options remain assignable to Context Builder, but are detached copies.
      result.contextRequirements.memoryKeys!.push("studySessionMinutes");
      result.contextRequirements.limits!.documents = 10;
    }
    expect(registry.get("tutor").contextRequirements).toEqual({
      memories: true,
      memoryKeys: ["academicGoal"],
      limits: { documents: 2 },
    });
  });

  it("keeps separate registry instances independent", () => {
    const first = new AgentRegistry();
    first.register(tutor());
    expect(new AgentRegistry().list()).toEqual([]);
  });

  it("supports explicitly declared future IDs without changing the registry", () => {
    const registry = new AgentRegistry<"custom-agent">();
    const agent: Agent<"custom-agent"> = { ...tutor(), id: "custom-agent" };
    registry.register(agent);
    registry.register(tutor());
    expect(registry.get("custom-agent").id).toBe("custom-agent");
    expect(registry.has("tutor")).toBe(true);
    expectTypeOf<
      Parameters<AgentRegistry["get"]>[0]
    >().toEqualTypeOf<AgentId>();
    expectTypeOf<Extract<"tutr", AgentId>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<"custom-agent", AgentId>>().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<"custom-agent", AgentId<"custom-agent">>
    >().toEqualTypeOf<"custom-agent">();
  });

  it("uses no AIProvider, OpenAI SDK, or Context Builder runtime", () => {
    const registry = studentRegistry();
    registry.get("tutor");
    registry.has("career");
    registry.list();
    registry.getByCapability("create-notes");
    expect(boundaries.ai).not.toHaveBeenCalled();
    expect(boundaries.context).not.toHaveBeenCalled();
  });
});

describe("student metadata and execution contracts", () => {
  it("declares only the six planned student agents and known capabilities", () => {
    const definitions = getStudentAgentDefinitions();
    expect(definitions.map((agent) => agent.id)).toEqual([
      ...STUDENT_AGENT_IDS,
    ]);
    expect(new Set(definitions.map((agent) => agent.id)).size).toBe(6);
    for (const agent of definitions) {
      expect(Object.keys(agent).sort()).toEqual([
        "capabilities",
        "contextRequirements",
        "description",
        "id",
        "name",
      ]);
      expect(agent.description.length).toBeLessThan(100);
      expect(agent.capabilities.length).toBeGreaterThan(0);
      for (const capability of agent.capabilities) {
        expect(AGENT_CAPABILITIES).toContain(capability);
      }
    }
  });

  it("declares the required categories using existing ContextOptions", () => {
    const registry = studentRegistry();
    const expected = {
      "academic-manager": [
        "academicOverview",
        "assignments",
        "course",
        "exams",
        "learning",
        "memories",
        "profile",
      ],
      tutor: ["course", "documents", "learning", "memories", "profile"],
      notes: ["course", "documents", "exams", "learning", "memories"],
      quiz: ["course", "documents", "learning", "memories", "profile"],
      "study-planner": [
        "assignments",
        "availability",
        "course",
        "exams",
        "learning",
        "memories",
        "profile",
      ],
      career: ["career", "course", "memories", "profile"],
    };
    for (const agent of registry.list()) {
      const options: ContextOptions = agent.contextRequirements;
      expect(
        Object.entries(options)
          .filter(([, value]) => value === true)
          .map(([key]) => key)
          .sort(),
      ).toEqual(expected[agent.id]);
    }
    expect(
      registry.get("academic-manager").contextRequirements.memoryKeys,
    ).toEqual(["academicGoal", "targetGrade", "studySessionMinutes", "planningIntensity"]);
    expect(
      registry.get("study-planner").contextRequirements.memoryKeys,
    ).toEqual(["academicGoal", "studySessionMinutes", "planningIntensity", "preferredStudyTime"]);
    expect(registry.get("career").contextRequirements.memoryKeys).toContain("targetRole");
  });

  it("does not expose shared nested student definitions", () => {
    getStudentAgentDefinitions()[0].contextRequirements.memoryKeys!.push(
      "explanationStyle",
    );
    expect(
      getStudentAgentDefinitions()[0].contextRequirements.memoryKeys,
    ).toEqual(["academicGoal", "targetGrade", "studySessionMinutes", "planningIntensity"]);
  });

  it("reuses context and usage types and supports typed future execution results", () => {
    expectTypeOf<AgentExecutionInput["context"]>().toEqualTypeOf<UserContext>();
    expectTypeOf<
      NonNullable<AgentExecutionResult["metadata"]>["usage"]
    >().toEqualTypeOf<AIUsage | undefined>();
    const result: AgentExecutionResult<{ concepts: string[] }> = {
      content: "Example contract value only.",
      agentId: "tutor",
      structuredData: { concepts: ["osmosis"] },
      sources: [
        {
          documentId: "doc-1",
          documentTitle: "Biology",
          pageNumber: 2,
          pageEnd: 3,
          courseId: "course-1",
          courseCode: "BIO101",
          chunkIndex: 0,
        },
      ],
    };
    expect(result.structuredData?.concepts).toEqual(["osmosis"]);
    expect(result.sources?.[0].pageEnd).toBe(3);
  });
});
