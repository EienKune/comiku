import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { PrismaService } from "../database/prisma.service.js";
import { Access } from "../common/access.js";

export class HealthResponse {
  @ApiProperty({ enum: ["ok"] })
  status = "ok" as const;

  @ApiProperty({ enum: ["comiku-server"] })
  service = "comiku-server" as const;
}

@ApiTags("system")
@Controller("health")
@Access({ public: true })
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ operationId: "getHealth", summary: "API process liveness" })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return new HealthResponse();
  }

  @Get("ready")
  @ApiOperation({
    operationId: "getReadiness",
    summary: "PostgreSQL readiness",
  })
  @ApiOkResponse({ type: HealthResponse })
  @ApiServiceUnavailableResponse({
    description: "Database unavailable; no connection details are exposed.",
  })
  async getReadiness(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return new HealthResponse();
    } catch {
      throw new ServiceUnavailableException("Database unavailable");
    }
  }
}
