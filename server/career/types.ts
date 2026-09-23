export type CareerContext = {
  profile: {
    updatedAt: string;
    careerGoal: string | null;
    targetRoles: string[];
    targetIndustries: string[];
    experiences: { evidenceId: string; text: string }[];
    portfolioLinks: string[];
    resumeText: string | null;
  } | null;
  projects: {
    id: string;
    updatedAt: string;
    evidenceId: string;
    name: string;
    description: string;
    technologies: string[];
    role: string | null;
    outcomes: string[];
    link: string | null;
    repositoryUrl: string | null;
    course: { id: string; courseCode: string; courseName: string } | null;
  }[];
  skills: {
    id: string;
    updatedAt: string;
    evidenceId: string;
    name: string;
    category: string | null;
    selfReportedProficiency: string | null;
    evidence: string[];
  }[];
  academicEvidence: {
    evidenceId: string;
    courseId: string;
    courseCode: string;
    courseName: string;
    description: string | null;
    updatedAt: string;
  }[];
  limitations: string[];
};
