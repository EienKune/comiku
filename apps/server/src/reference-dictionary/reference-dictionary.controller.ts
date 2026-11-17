import { Controller, Get, Header, Inject, Query } from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access } from "../common/access.js";
import { ReferenceDictionaryService } from "./reference-dictionary.service.js";
import { ReferenceDictionaryPageDto } from "./reference-dictionary.dto.js";

@ApiTags("reference-dictionary")
@ApiCookieAuth()
@Controller("reference-dictionary")
export class ReferenceDictionaryController {
  constructor(
    @Inject(ReferenceDictionaryService)
    private readonly dictionary: ReferenceDictionaryService,
  ) {}
  @Get()
  @Access({ permission: "works:read" })
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ operationId: "searchReferenceDictionary" })
  @ApiQuery({ name: "q", type: String, required: false, maxLength: 80 })
  @ApiQuery({
    name: "offset",
    type: Number,
    required: false,
    minimum: 0,
    maximum: 10000,
  })
  @ApiOkResponse({ type: ReferenceDictionaryPageDto })
  search(@Query("q") q: unknown, @Query("offset") offset: unknown) {
    return this.dictionary.search(q, offset);
  }
}
