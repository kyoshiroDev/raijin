import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Accès à la base (global) : importé une fois par `apps/api`. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class ApiPrismaModule {}
