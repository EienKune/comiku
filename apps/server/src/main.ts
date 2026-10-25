import "reflect-metadata";
import { SwaggerModule } from "@nestjs/swagger";
import { createApplication, createOpenApiDocument } from "./application.js";
import { loadEnvironment } from "./config/environment.js";

async function bootstrap() {
  const environment = loadEnvironment();
  const app = await createApplication(environment);
  app.enableShutdownHooks();

  if (environment.nodeEnv !== "production") {
    SwaggerModule.setup("api/docs", app, () => createOpenApiDocument(app), {
      jsonDocumentUrl: "api/openapi.json",
    });
  }

  try {
    await app.listen(environment.port, environment.host);
  } catch {
    await app.close();
    throw new Error(
      "API startup failed; check the listen address and PostgreSQL availability.",
    );
  }
}

await bootstrap();
