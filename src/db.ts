import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.ts';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL отсутствует: скопируй .env.example в .env');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const db = new PrismaClient({ adapter });
