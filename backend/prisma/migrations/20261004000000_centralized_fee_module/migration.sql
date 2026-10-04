-- Centralized Fee Module: fee heads, Program + Batch fee structures with the
-- locked semester-fee snapshot, Provost fee notifications, payments and
-- concessions. Additive: LmsFeeAnnouncement and existing challans are kept.

-- CreateTable
CREATE TABLE "FeeHead" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "isRecurring" BOOLEAN NOT NULL DEFAULT true,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BatchFeeStructure" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "programCode" TEXT NOT NULL,
    "programName" TEXT NOT NULL DEFAULT '',
    "batch" TEXT NOT NULL,
    "admissionCycleId" INTEGER,
    "semesterFee" REAL NOT NULL DEFAULT 0,
    "items" TEXT NOT NULL DEFAULT '[]',
    "lockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FeeNotification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "programs" TEXT NOT NULL DEFAULT '[]',
    "batches" TEXT NOT NULL DEFAULT '[]',
    "semesters" TEXT NOT NULL DEFAULT '[]',
    "items" TEXT NOT NULL DEFAULT '[]',
    "includeSemesterDues" BOOLEAN NOT NULL DEFAULT true,
    "dueDate" TEXT NOT NULL,
    "lateFeeType" TEXT NOT NULL DEFAULT 'NONE',
    "lateFeeAmount" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "targetedCount" INTEGER NOT NULL DEFAULT 0,
    "generatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedJson" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LmsPaymentMethod" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confirmMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "instructions" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LmsFeePayment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "challanId" INTEGER NOT NULL,
    "studentId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'STUDENT',
    "recordedById" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LmsFeePayment_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "LmsFeeChallan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConcessionType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'REDUCTION',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FeeConcession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "studentId" TEXT NOT NULL,
    "typeId" INTEGER NOT NULL,
    "typeName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'PERCENT',
    "value" REAL NOT NULL,
    "headIds" TEXT NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "proofPath" TEXT NOT NULL,
    "proofName" TEXT,
    "startSemester" INTEGER NOT NULL,
    "endSemester" INTEGER,
    "minCgpa" REAL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reviewNote" TEXT,
    "revokedAt" DATETIME,
    "revokeReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LmsFeeChallan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "studentId" TEXT NOT NULL,
    "termId" INTEGER,
    "challanNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lineItems" TEXT NOT NULL DEFAULT '[]',
    "grossAmount" REAL NOT NULL DEFAULT 0,
    "discountAmount" REAL NOT NULL DEFAULT 0,
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "lateFee" REAL NOT NULL DEFAULT 0,
    "paidAmount" REAL NOT NULL DEFAULT 0,
    "dueDate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "paidAt" DATETIME,
    "paymentRef" TEXT,
    "kind" TEXT,
    "feeType" TEXT,
    "program" TEXT,
    "batch" TEXT,
    "department" TEXT,
    "semester" INTEGER,
    "section" TEXT,
    "description" TEXT,
    "notificationId" INTEGER,
    "sourceAnnouncementId" INTEGER,
    "reminderSentAt" DATETIME,
    "overdueNotifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LmsFeeChallan" ("challanNo", "createdAt", "department", "description", "dueDate", "feeType", "id", "lineItems", "paidAt", "paymentRef", "program", "section", "semester", "sourceAnnouncementId", "status", "studentId", "termId", "title", "totalAmount", "updatedAt") SELECT "challanNo", "createdAt", "department", "description", "dueDate", "feeType", "id", "lineItems", "paidAt", "paymentRef", "program", "section", "semester", "sourceAnnouncementId", "status", "studentId", "termId", "title", "totalAmount", "updatedAt" FROM "LmsFeeChallan";
DROP TABLE "LmsFeeChallan";
ALTER TABLE "new_LmsFeeChallan" RENAME TO "LmsFeeChallan";
CREATE UNIQUE INDEX "LmsFeeChallan_challanNo_key" ON "LmsFeeChallan"("challanNo");
CREATE INDEX "LmsFeeChallan_studentId_idx" ON "LmsFeeChallan"("studentId");
CREATE INDEX "LmsFeeChallan_status_idx" ON "LmsFeeChallan"("status");
CREATE INDEX "LmsFeeChallan_kind_idx" ON "LmsFeeChallan"("kind");
CREATE INDEX "LmsFeeChallan_notificationId_idx" ON "LmsFeeChallan"("notificationId");
CREATE INDEX "LmsFeeChallan_sourceAnnouncementId_idx" ON "LmsFeeChallan"("sourceAnnouncementId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "FeeHead_name_key" ON "FeeHead"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BatchFeeStructure_programCode_batch_key" ON "BatchFeeStructure"("programCode", "batch");

-- CreateIndex
CREATE INDEX "FeeNotification_status_idx" ON "FeeNotification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LmsPaymentMethod_code_key" ON "LmsPaymentMethod"("code");

-- CreateIndex
CREATE UNIQUE INDEX "LmsFeePayment_reference_key" ON "LmsFeePayment"("reference");

-- CreateIndex
CREATE INDEX "LmsFeePayment_challanId_idx" ON "LmsFeePayment"("challanId");

-- CreateIndex
CREATE INDEX "LmsFeePayment_studentId_idx" ON "LmsFeePayment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ConcessionType_name_key" ON "ConcessionType"("name");

-- CreateIndex
CREATE INDEX "FeeConcession_studentId_idx" ON "FeeConcession"("studentId");

-- CreateIndex
CREATE INDEX "FeeConcession_status_idx" ON "FeeConcession"("status");

-- CreateIndex
CREATE INDEX "FeeConcession_category_idx" ON "FeeConcession"("category");


-- Back-fill money columns for challans created before this migration.
UPDATE "LmsFeeChallan" SET "grossAmount" = "totalAmount";
UPDATE "LmsFeeChallan" SET "paidAmount" = "totalAmount" WHERE "status" = 'PAID';
UPDATE "LmsFeeChallan" SET "kind" = CASE WHEN "feeType" = 'OTHER' THEN 'FINE' ELSE 'NOTIFICATION' END;
