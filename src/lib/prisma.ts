import { PrismaClient } from "@prisma/client";

/**
 * Single shared Prisma client for the whole process.
 *
 * Previously each service (auth, game history, rating, puzzles) created its
 * own `new PrismaClient()`, which means its own connection pool to Postgres —
 * under load that multiplied real DB connections by 4x for no reason. Import
 * `prisma` from here everywhere instead of constructing a new client.
 */
export const prisma = new PrismaClient();
