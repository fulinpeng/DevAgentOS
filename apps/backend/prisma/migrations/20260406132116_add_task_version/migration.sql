-- CreateTable
CREATE TABLE "TaskVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskVersion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskVersion_taskId_idx" ON "TaskVersion"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskVersion_taskId_version_key" ON "TaskVersion"("taskId", "version");
