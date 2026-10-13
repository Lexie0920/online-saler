import { OperationsRequestIdentity } from "./operations-request-identity";
import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import { InventoryItemStatus, WarehouseLocationStatus } from "@online-saler/database";
import {
  OperationsFulfillmentService,
  type AdminInput,
  type AfterSaleInput,
  type BatchReassignInput,
  type CodelessCompletionInput,
  type ReassignInput,
  type DeliveryCodeInput,
  type DeliveryCostInput,
  type DeliveryFailureInput,
  type DispatchInput,
  type DispatchToRiderInput,
  type EmployeeInput,
  type LabelPrintedInput,
  type ExceptionInput,
  type NodeInput,
  type OrderCenterListInput,
  type PackingInput,
  type PickupInput,
  type RefundInput,
  type RiderInput,
  type ScanInput,
  type WriteOffInput
} from "./operations-fulfillment.service";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsWarehouseService } from "./operations-warehouse.service";

@Controller("operations/orders")
export class OperationsFulfillmentController {
  constructor(
    private readonly orders: OperationsFulfillmentService,
    private readonly access: OperationsAccessService
  ) {}

  @Get("summary")
  async summary(@Headers("authorization") authorization: string | undefined, @Query() query: OrderCenterListInput) {
    return this.orders.summary({ ...query, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  @Get("fulfillment-counts")
  async fulfillmentCounts(@Headers("authorization") authorization: string | undefined, @Query() query: OrderCenterListInput) {
    return this.orders.fulfillmentStatusCounts({ ...query, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  @Get("employees")
  async employees(@Headers("authorization") authorization?: string) {
    return this.orders.employees(await this.access.requireAccessToken(authorization));
  }

  @Get()
  async list(@Headers("authorization") authorization: string | undefined, @Query() query: OrderCenterListInput) {
    return this.orders.listOrders({ ...query, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  @Get("nodes")
  async nodes(@Headers("authorization") authorization?: string) {
    return this.orders.nodes(await this.access.requireAccessToken(authorization));
  }

  @Get(":orderId")
  async detail(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string) {
    return this.orders.orderDetail(orderId, await this.access.requireAccessToken(authorization));
  }

  @Post(":orderId/assign-picker")
  async assignPicker(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: EmployeeInput) {
    return this.orders.assignPicker(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /** 改派拣货员: moves a task already being picked. Supervisors only; a reason is required. */
  @Post(":orderId/reassign-picker")
  async reassignPicker(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: ReassignInput) {
    return this.orders.reassignPicker(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /** 改派打包员: moves a parcel waiting to be packed, even once packing has started. */
  @Post(":orderId/reassign-packer")
  async reassignPacker(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: ReassignInput) {
    return this.orders.reassignPacker(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /**
   * 批量改派: { orderIds, employeeId, reason }. Each order is checked against
   * the caller's store scope inside the service before it is touched.
   */
  @Post("reassign-batch")
  async reassignBatch(@Headers("authorization") authorization: string | undefined, @Body() body: BatchReassignInput) {
    return this.orders.reassignBatch({ ...body, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  /** 无码补登: super admin only, checked by role inside the service. */
  @Post(":orderId/complete-without-code")
  async completeWithoutCode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: CodelessCompletionInput) {
    return this.orders.completeWithoutCode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/assign-packer")
  async assignPacker(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: EmployeeInput) {
    return this.orders.assignPacker(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/claim-picking")
  async claimPicking(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.claimPicking(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/items/:orderItemId/scan")
  async scanItem(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Param("orderItemId") orderItemId: string, @Body() body: ScanInput) {
    return this.orders.scanItem(orderId, orderItemId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/start-packing")
  async startPacking(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: EmployeeInput) {
    return this.orders.startPacking(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/complete-packing")
  async completePacking(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: PackingInput) {
    return this.orders.completePacking(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/ready-for-pickup")
  async readyForPickup(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.readyForPickup(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/ready-for-dispatch")
  async readyForDispatch(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.readyForDispatch(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/assign-rider")
  async assignRider(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: RiderInput) {
    return this.orders.assignRider(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/dispatch")
  async dispatch(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: DispatchInput) {
    return this.orders.dispatch(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/confirm-pickup")
  async confirmPickup(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: PickupInput) {
    return this.orders.confirmPickup(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /**
   * The store hands the package to one of its riders. One call does the lot:
   * assigns the rider, mints the delivery code, moves the status, texts the
   * customer and writes the event.
   */
  @Post(":orderId/dispatch-to-rider")
  async dispatchToRider(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: DispatchToRiderInput) {
    return this.orders.dispatchToRider(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /** Replaces the delivery code and texts the new one. Nobody sees either. */
  @Post(":orderId/resend-delivery-code")
  async resendDeliveryCode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.resendDeliveryCode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/delivery-failed")
  async deliveryFailed(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: DeliveryFailureInput) {
    return this.orders.markDeliveryFailed(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/return-to-node")
  async returnToNode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.startReturnToNode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/confirm-return")
  async confirmReturn(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.confirmReturnAtNode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/complete-delivery")
  async completeDelivery(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: DeliveryCodeInput) {
    return this.orders.completeDelivery(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/exception")
  async exception(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: ExceptionInput) {
    return this.orders.markException(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/cancel")
  async cancel(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.cancel(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/assign-node")
  async assignNode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: NodeInput) {
    return this.orders.assignNode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/send-to-node")
  async sendToNode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.sendToNode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/package-label-printed")
  async packageLabelPrinted(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: LabelPrintedInput) {
    return this.orders.markPackageLabelPrinted(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/receive-at-node")
  async receiveAtNode(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput & { packageCode?: string }) {
    return this.orders.receiveAtNode(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/delivery-cost")
  async deliveryCost(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: DeliveryCostInput) {
    return this.orders.recordDeliveryCost(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/resolve-exception")
  async resolveException(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AdminInput) {
    return this.orders.resolveException(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/write-off")
  async writeOff(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: WriteOffInput) {
    return this.orders.writeOff(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/refund")
  async refund(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: RefundInput) {
    return this.orders.recordRefund(orderId, await this.scopedInput(authorization, orderId, body));
  }

  @Post(":orderId/assign-after-sale")
  async assignAfterSale(@Headers("authorization") authorization: string | undefined, @Param("orderId") orderId: string, @Body() body: AfterSaleInput) {
    return this.orders.assignAfterSale(orderId, await this.scopedInput(authorization, orderId, body));
  }

  /**
   * Every order action goes through here. A store account may act only on its
   * own store's orders; the check runs before the action so a refused request
   * changes nothing.
   */
  private async scopedInput<T extends AdminInput>(authorization: string | undefined, orderId: string, input: T): Promise<T> {
    const adminUserId = await this.access.requireAccessToken(authorization);
    await this.orders.assertOrderInStoreScope(orderId, adminUserId);
    return { ...input, adminUserId };
  }
}

@Controller("operations/warehouse-locations")
export class OperationsWarehouseLocationsController {
  constructor(private readonly warehouse: OperationsWarehouseService, private readonly identity: OperationsRequestIdentity) {}

  @Get()
  async list(
    @Headers("authorization") authorization?: string,
    @Query("search") search?: string,
    @Query("status") status?: WarehouseLocationStatus,
    @Query("minCapacity") minCapacity?: string,
    @Query("maxCapacity") maxCapacity?: string,
    @Query("onlyAvailable") onlyAvailable?: string,
    @Query("onlyFull") onlyFull?: string
  ) {
    return this.warehouse.listLocations({
      adminUserId: await this.identity.adminId(authorization),
      search,
      status,
      minCapacity: optionalNumber(minCapacity),
      maxCapacity: optionalNumber(maxCapacity),
      onlyAvailable: onlyAvailable === "true",
      onlyFull: onlyFull === "true"
    });
  }

  @Get("summary")
  async summary(@Headers("authorization") authorization?: string) {
    return this.warehouse.locationSummary(await this.identity.adminId(authorization));
  }

  @Post()
  async create(@Headers("authorization") authorization: string | undefined, @Body() body: { adminUserId?: string; locationCode?: string; capacity?: number; status?: WarehouseLocationStatus; note?: string }) {
    return this.warehouse.createLocation(await this.identity.adminInput(authorization, body));
  }

  @Post("bulk")
  async bulk(@Headers("authorization") authorization: string | undefined, @Body() body: { adminUserId?: string; prefix?: string; start?: string | number; end?: string | number; capacity?: number; status?: WarehouseLocationStatus; note?: string }) {
    return this.warehouse.bulkCreateLocations(await this.identity.adminInput(authorization, body));
  }

  @Patch(":locationId/status")
  async status(@Headers("authorization") authorization: string | undefined, @Param("locationId") locationId: string, @Body() body: { adminUserId?: string; status?: WarehouseLocationStatus; note?: string }) {
    return this.warehouse.setLocationStatus(locationId, await this.identity.adminInput(authorization, body));
  }

  @Patch(":locationId/capacity")
  async capacity(@Headers("authorization") authorization: string | undefined, @Param("locationId") locationId: string, @Body() body: { adminUserId?: string; capacity?: number; note?: string }) {
    return this.warehouse.updateCapacity(locationId, await this.identity.adminInput(authorization, body));
  }

  @Post("move-item")
  async moveItem(@Headers("authorization") authorization: string | undefined, @Body() body: { adminUserId?: string; inventoryItemId?: string; locationId?: string; note?: string }) {
    return this.warehouse.moveInventoryItem(await this.identity.adminInput(authorization, body));
  }
}

@Controller("operations/inventory-overview")
export class OperationsInventoryOverviewController {
  constructor(private readonly warehouse: OperationsWarehouseService, private readonly identity: OperationsRequestIdentity) {}

  @Get()
  async overview(
    @Headers("authorization") authorization?: string,
    @Query("category") category?: string,
    @Query("gender") gender?: string,
    @Query("size") size?: string,
    @Query("condition") condition?: string,
    @Query("published") published?: "published" | "unpublished",
    @Query("inventoryStatus") inventoryStatus?: InventoryItemStatus
  ) {
    return this.warehouse.inventoryOverview({
      adminUserId: await this.identity.adminId(authorization),
      category,
      gender,
      size,
      condition,
      published,
      inventoryStatus
    });
  }
}

function optionalNumber(value?: string) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
