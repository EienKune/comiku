import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";
import type { Environment } from "./config/environment.js";
import { ErrorDto, SafeExceptionFilter } from "./common/http.js";
import type { Request, Response, NextFunction } from "express";

export function configureApplication(app: INestApplication): void {
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new SafeExceptionFilter());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
}

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("Comiku API")
    .setDescription("Comiku self-hosted scanlation workflow API")
    .setVersion("0.9.0")
    .addCookieAuth("comiku_session")
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controller, method) => method,
    extraModels: [ErrorDto],
  });
  for (const path of Object.values(document.paths)) {
    for (const method of ["get", "post", "patch", "put", "delete"] as const) {
      const operation = path?.[method];
      if (!operation) continue;
      for (const [status, description] of Object.entries({
        400: "请求字段无效",
        401: "登录失效",
        403: "权限、来源或改密限制",
        404: "资源不存在",
        409: "数据冲突",
        429: "请求频率限制",
        500: "服务器错误",
      })) {
        operation.responses[status] ??= {
          description,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ErrorDto" },
            },
          },
        };
      }
    }
  }
  return document;
}

export async function createApplication(environment: Environment) {
  const app = await NestFactory.create(AppModule.forRoot(environment), {
    abortOnError: false,
    logger: environment.nodeEnv === "test" ? false : undefined,
  });
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", environment.trustedProxyCidrs ?? false);
  app.enableCors({
    origin: environment.appOrigin,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Comiku-Request"],
  });
  configureApplication(app);
  return app;
}
