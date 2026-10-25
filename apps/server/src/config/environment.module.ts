import { Global, Module, type DynamicModule } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "./environment.js";

@Global()
@Module({})
export class EnvironmentModule {
  static forRoot(environment: Environment): DynamicModule {
    return {
      module: EnvironmentModule,
      providers: [
        { provide: ENVIRONMENT, useValue: Object.freeze(environment) },
      ],
      exports: [ENVIRONMENT],
    };
  }
}
