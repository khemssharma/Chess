-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "whiteUserId" INTEGER,
    "blackUserId" INTEGER,
    "fen" TEXT NOT NULL,
    "moveHistory" JSONB NOT NULL,
    "moveCount" INTEGER NOT NULL,
    "timeControl" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "winner" TEXT,
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_whiteUserId_fkey" FOREIGN KEY ("whiteUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_blackUserId_fkey" FOREIGN KEY ("blackUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
