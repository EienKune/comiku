import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { BusinessAuditController } from "./business-audit.controller.js";
import { BusinessAuditService } from "./business-audit.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [BusinessAuditController],
  providers: [BusinessAuditService],
})
export class BusinessAuditModule {}
