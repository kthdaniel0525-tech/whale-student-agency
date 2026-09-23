CREATE TYPE "CareerPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "CareerTaskCategory" AS ENUM ('SKILL', 'PROJECT', 'RESUME', 'PORTFOLIO', 'INTERVIEW', 'APPLICATION');

CREATE TABLE "CareerPlan" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetRole" TEXT NOT NULL,
  "targetIndustry" TEXT,
  "startDate" TIMESTAMP(3) NOT NULL,
  "targetDate" TIMESTAMP(3),
  "weeklyAvailableMinutes" INTEGER NOT NULL,
  "totalPlannedMinutes" INTEGER NOT NULL DEFAULT 0,
  "summary" TEXT NOT NULL,
  "status" "CareerPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CareerPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CareerPlan_weeklyAvailableMinutes_check" CHECK ("weeklyAvailableMinutes" > 0 AND "weeklyAvailableMinutes" <= 2400),
  CONSTRAINT "CareerPlan_totalPlannedMinutes_check" CHECK ("totalPlannedMinutes" >= 0)
);

CREATE TABLE "CareerTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "careerPlanId" TEXT NOT NULL,
  "projectId" TEXT,
  "actionId" TEXT NOT NULL,
  "weekNumber" INTEGER NOT NULL,
  "category" "CareerTaskCategory" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "priority" INTEGER NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "status" "StudyTaskStatus" NOT NULL DEFAULT 'PLANNED',
  "targetDate" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CareerTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CareerTask_weekNumber_check" CHECK ("weekNumber" > 0),
  CONSTRAINT "CareerTask_priority_check" CHECK ("priority" >= 1 AND "priority" <= 100),
  CONSTRAINT "CareerTask_durationMinutes_check" CHECK ("durationMinutes" > 0 AND "durationMinutes" <= 2400)
);

CREATE UNIQUE INDEX "Project_id_userId_key" ON "Project"("id", "userId");
CREATE UNIQUE INDEX "CareerPlan_id_userId_key" ON "CareerPlan"("id", "userId");
CREATE INDEX "CareerPlan_userId_status_startDate_targetDate_idx" ON "CareerPlan"("userId", "status", "startDate", "targetDate");
CREATE INDEX "CareerTask_careerPlanId_userId_weekNumber_status_idx" ON "CareerTask"("careerPlanId", "userId", "weekNumber", "status");
CREATE INDEX "CareerTask_userId_targetDate_status_idx" ON "CareerTask"("userId", "targetDate", "status");
CREATE INDEX "CareerTask_projectId_userId_idx" ON "CareerTask"("projectId", "userId");

ALTER TABLE "CareerPlan" ADD CONSTRAINT "CareerPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerTask" ADD CONSTRAINT "CareerTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerTask" ADD CONSTRAINT "CareerTask_careerPlanId_userId_fkey" FOREIGN KEY ("careerPlanId", "userId") REFERENCES "CareerPlan"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CareerTask" ADD CONSTRAINT "CareerTask_projectId_userId_fkey" FOREIGN KEY ("projectId", "userId") REFERENCES "Project"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
