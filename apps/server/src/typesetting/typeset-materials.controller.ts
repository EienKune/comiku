import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  CreateTypesetMaterialDto,
  TypesetMaterialDto,
} from "./typeset-materials.dto.js";
import { TypesetMaterialsService } from "./typeset-materials.service.js";

@ApiTags("typesetting")
@ApiCookieAuth()
@Controller("works/:workId/typeset/materials")
export class TypesetMaterialsController {
  constructor(
    @Inject(TypesetMaterialsService)
    private readonly materials: TypesetMaterialsService,
  ) {}
  @Post()
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "createTypesetMaterial" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiBody({ type: CreateTypesetMaterialDto })
  @ApiOkResponse({ type: TypesetMaterialDto })
  create(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Body(bodyValidation(CreateTypesetMaterialDto))
    input: CreateTypesetMaterialDto,
  ) {
    return this.materials.create(req.actor.userId, workId, input);
  }
  @Post(":materialId/deliver")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "deliverTypesetMaterial" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "materialId", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOkResponse({ type: TypesetMaterialDto })
  deliver(
    @Req() req: AuthRequest,
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("materialId", ParseUUIDPipe) id: string,
  ) {
    return this.materials.deliver(req.actor.userId, workId, id);
  }
}
