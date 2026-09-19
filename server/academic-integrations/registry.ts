import "server-only";
import { academicCapabilities, type AcademicCapability } from "@/lib/student/academic-integrations/types";
import type { AcademicIntegrationProvider } from "./types";
import { AcademicIntegrationError } from "./errors";
export class AcademicProviderRegistry {
    private readonly providers = new Map<string, AcademicIntegrationProvider>();
    constructor(private readonly allowTestProviders = false) { }
    register(provider: AcademicIntegrationProvider) {
        if (!/^[a-z][a-z0-9-]{1,79}$/.test(provider.id) || this.providers.has(provider.id) || (!provider.productionReady && !this.allowTestProviders) || (provider.authentication === "test" && !this.allowTestProviders))
            throw new AcademicIntegrationError("CONFIGURATION");
        const methods = { "courses-read": [provider.listCourses, provider.getCourse], "assignments-read": [provider.listAssignments], "assessments-read": [provider.listAssessments], "files-read": [provider.listFiles, provider.downloadFile], "announcements-read": [] };
        if (!provider.capabilities.includes("courses-read") || provider.capabilities.some(capability => !academicCapabilities.includes(capability) || methods[capability].some(method => typeof method !== "function")))
            throw new AcademicIntegrationError("CONFIGURATION");
        this.providers.set(provider.id, provider);
        return this;
    }
    get(id: string) { const provider = this.providers.get(id); if (!provider)
        throw new AcademicIntegrationError("CONFIGURATION"); return provider; }
    list() { return [...this.providers.values()]; }
    supports(id: string, capability: AcademicCapability) { return this.get(id).capabilities.includes(capability); }
}
// No institution is chosen implicitly. Test adapters are injected only by automated tests.
export const academicProviderRegistry = new AcademicProviderRegistry();
