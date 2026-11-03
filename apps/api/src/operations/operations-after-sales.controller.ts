import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from "@nestjs/common";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsAfterSalesService, type AfterSalesInput } from "./operations-after-sales.service";
import { OperationsExchangeService, type ExchangeInput } from "./operations-exchange.service";

/** What a store is still waiting to get back over the counter. */
@Controller("operations/nodes/:nodeId/returns")
export class OperationsNodeReturnsController {
  constructor(private readonly service: OperationsAfterSalesService, private readonly access: OperationsAccessService) {}

  @Get()
  async toReceive(@Headers("authorization") authorization: string | undefined, @Param("nodeId") nodeId: string) {
    return this.service.returnsToReceive(nodeId, await this.access.requireAccessToken(authorization));
  }
}

/** The returns record sheet for finance and review. Read-only. */
@Controller("operations/after-sales")
export class OperationsAfterSalesExportController {
  constructor(private readonly service: OperationsAfterSalesService, private readonly access: OperationsAccessService) {}

  /** from/to are Nairobi dates (YYYY-MM-DD, default last 30 days); filter=all|to-refund. */
  @Get("export")
  async exportList(@Headers("authorization") authorization: string | undefined, @Query("from") from?: string, @Query("to") to?: string, @Query("filter") filter?: string) {
    return this.service.exportList({ adminUserId: await this.access.requireAccessToken(authorization), from, to, filter });
  }
}

/** Swap a garment on a paid order for another. */
@Controller("operations/orders/:orderId/exchange")
export class OperationsExchangeController {
  constructor(private readonly service: OperationsExchangeService, private readonly access: OperationsAccessService) {}

  @Post()
  async exchange(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: ExchangeInput) {
    return this.service.exchange(orderId, body ?? {}, await this.access.requireAccessToken(authorization));
  }
}

@Controller("operations/orders/:orderId/after-sales")
export class OperationsAfterSalesController {
  constructor(private readonly service: OperationsAfterSalesService, private readonly access: OperationsAccessService) {}

  @Get()
  async list(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string) {
    return this.service.list(orderId, await this.access.requireAccessToken(authorization));
  }

  @Post()
  async request(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AfterSalesInput) {
    return this.service.execute(orderId, undefined, "REQUEST", body, await this.access.requireAccessToken(authorization));
  }

  @Post(":returnId/decision")
  async decision(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Body() body: AfterSalesInput) {
    return this.service.execute(orderId, returnId, "DECISION", body, await this.access.requireAccessToken(authorization));
  }

  @Post(":returnId/receive")
  async receive(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Body() body: AfterSalesInput) {
    return this.service.execute(orderId, returnId, "RECEIVE", body, await this.access.requireAccessToken(authorization));
  }

  /** Raw image bytes, the way the manual cutout upload works; the image type comes from Content-Type. */
  @Post(":returnId/photos")
  async uploadPhoto(@Headers("authorization") authorization: string | undefined, @Headers("content-type") contentType: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Req() request: any) {
    const adminUserId = await this.access.requireAccessToken(authorization);
    return this.service.uploadPhoto(orderId, returnId, adminUserId, contentType, await readPhotoBody(request));
  }

  @Get(":returnId/photos/:photoId/content")
  async photoContent(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Param("photoId") photoId: string, @Res() response: any) {
    const stored = await this.service.photoContent(orderId, returnId, photoId, await this.access.requireAccessToken(authorization));
    response.setHeader("Content-Type", stored.contentType);
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.send(Buffer.from(stored.body));
  }

  @Post(":returnId/refunds")
  async refund(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Body() body: AfterSalesInput) {
    return this.service.execute(orderId, returnId, "REFUND", body, await this.access.requireAccessToken(authorization));
  }

  @Post(":returnId/restock")
  async restock(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("returnId") returnId: string, @Body() body: AfterSalesInput) {
    return this.service.execute(orderId, returnId, "RESTOCK", body, await this.access.requireAccessToken(authorization));
  }
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

async function readPhotoBody(request: any): Promise<Buffer> {
  if (Buffer.isBuffer(request.body)) {
    if (!request.body.length || request.body.length > MAX_PHOTO_BYTES) throw new BadRequestException("A photo must be between 1 byte and 10 MB.");
    return request.body;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PHOTO_BYTES) throw new BadRequestException("A photo must be between 1 byte and 10 MB.");
    chunks.push(buffer);
  }
  if (!size) throw new BadRequestException("A photo is required.");
  return Buffer.concat(chunks);
}
