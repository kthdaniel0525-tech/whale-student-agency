export type CourseOption = {
  id: string;
  courseCode: string;
  courseName: string;
};
export type DocumentItem = {
  id: string;
  title: string;
  originalFileName: string;
  fileType: string;
  fileSize: number;
  courseId: string | null;
  processingStatus: "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
  processingError: string | null;
  pageCount: number | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
  course: CourseOption | null;
  _count: { chunks: number };
};
export type SearchResult = {
  id: string;
  content: string;
  documentTitle: string;
  documentId: string;
  pageNumber: number | null;
  pageEnd: number | null;
  courseId: string | null;
  courseCode: string | null;
  chunkIndex: number;
  similarityScore: number;
};
