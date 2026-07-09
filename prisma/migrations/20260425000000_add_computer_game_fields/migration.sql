-- AlterTable: add computer game metadata columns
ALTER TABLE "Game" ADD COLUMN "isVsComputer" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Game" ADD COLUMN "computerDifficulty" TEXT;
