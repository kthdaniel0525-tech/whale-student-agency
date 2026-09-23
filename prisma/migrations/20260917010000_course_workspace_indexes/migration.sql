CREATE INDEX "Assignment_userId_courseId_dueDate_idx"
ON "Assignment"("userId", "courseId", "dueDate");

CREATE INDEX "Exam_userId_courseId_examDate_idx"
ON "Exam"("userId", "courseId", "examDate");
