import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import type { Request } from "express";
import type { Response } from "express";
import { Access } from "../common/access.js";
import { LocalObjectStorage } from "./local-object-storage.js";
import { MemoryObjectStorage } from "./memory-object-storage.js";
import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.js";

@Controller("local-files")
export class LocalFilesController {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Put("uploads/:token")
  @HttpCode(200)
  @Access({ public: true, contentType: "application/octet-stream" })
  @ApiExcludeEndpoint()
  async write(@Param("token") token: string, @Req() request: Request) {
    if (
      !(this.storage instanceof LocalObjectStorage) &&
      !(this.storage instanceof MemoryObjectStorage)
    ) {
      throw new NotFoundException("本地上传入口不可用");
    }
    let signed;
    try {
      signed = this.storage.signedWriteMetadata(token);
    } catch {
      throw new BadRequestException("上传签名无效或已过期");
    }
    const limit =
      signed.key.startsWith("staging/typeset-upload/") &&
      signed.contentType === "application/zip"
        ? 250 * 1024 * 1024
        : 25 * 1024 * 1024;
    if (signed.size > limit)
      throw new PayloadTooLargeException("文件超过当前用途的容量上限");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > signed.size) {
        throw new PayloadTooLargeException("上传内容超过签名约定的大小");
      }
      chunks.push(buffer);
    }
    try {
      await this.storage.writeSigned(token, Buffer.concat(chunks, size));
      return { ok: true };
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : "上传签名无效",
      );
    }
  }

  @Get(":token")
  @Access({ permission: "self" })
  async read(
    @Param("token") token: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!(this.storage instanceof LocalObjectStorage)) {
      throw new NotFoundException("本地文件入口不可用");
    }
    try {
      const file = await this.storage.readSignedStream(token);
      response.setHeader("Content-Type", file.contentType);
      response.setHeader("Cache-Control", "private, max-age=30");
      if (file.fileName)
        response.setHeader(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        );
      return new StreamableFile(file.body);
    } catch {
      throw new NotFoundException("文件地址无效或已过期");
    }
  }
}
