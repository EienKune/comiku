import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { ENVIRONMENT, type Environment } from "../config/environment.js";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(@Inject(ENVIRONMENT) environment: Environment) {
    super({
      adapter: new PrismaPg({
        connectionString: environment.databaseUrl,
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        query_timeout: 5000,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
