CREATE TABLE "CareerProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "careerGoal" TEXT,
  "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "experiences" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "portfolioLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "resumeText" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CareerProfile_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "role" TEXT,
  "outcomes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "link" TEXT,
  "repositoryUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Skill" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT,
  "proficiency" TEXT,
  "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CareerProfile_userId_key" ON "CareerProfile"("userId");
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");
CREATE INDEX "Project_courseId_userId_idx" ON "Project"("courseId", "userId");
CREATE INDEX "Skill_userId_updatedAt_idx" ON "Skill"("userId", "updatedAt");
ALTER TABLE "CareerProfile" ADD CONSTRAINT "CareerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_courseId_userId_fkey" FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
