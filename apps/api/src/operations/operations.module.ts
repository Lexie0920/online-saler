import { OperationsAfterSalesController, OperationsNodeReturnsController } from "./operations-after-sales.controller";
import { OperationsAfterSalesService } from "./operations-after-sales.service";
import { Module } from "@nestjs/common";
import { AIModule } from "../ai/ai.module";
import { ProductModule } from "../product/product.module";
import { OperationsAccessController } from "./operations-access.controller";
import { OperationsAccessModule } from "./operations-access.module";
import { OperationsAffiliateController } from "./operations-affiliate.controller";
import { OperationsAffiliateService } from "./operations-affiliate.service";
import { OperationsAnalyticsController } from "./operations-analytics.controller";
import { OperationsAnalyticsService } from "./operations-analytics.service";
import { OperationsCustomerServiceController } from "./operations-customer-service.controller";
import { OperationsCustomerServiceDeskService } from "./operations-customer-service-desk.service";
import { OperationsRefundRequestController } from "./operations-refund-request.controller";
import { OperationsRefundRequestService } from "./operations-refund-request.service";
import { OperationsCustomerServiceService } from "./operations-customer-service.service";
import {
  OperationsFulfillmentController,
  OperationsInventoryOverviewController,
  OperationsWarehouseLocationsController
} from "./operations-fulfillment.controller";
import { OperationsFulfillmentService } from "./operations-fulfillment.service";
import { OperationsFinanceController } from "./operations-finance.controller";
import { OperationsFinanceService } from "./operations-finance.service";
import { OperationsNodeAdminController, OperationsNotificationsController } from "./operations-node-admin.controller";
import { OperationsNodeAdminService } from "./operations-node-admin.service";
import { OperationsDepositHoldsController } from "./operations-deposit-holds.controller";
import { OperationsDepositHoldsService } from "./operations-deposit-holds.service";
import { OperationsPaymentReviewController } from "./operations-payment-review.controller";
import { OperationsPaymentReviewService } from "./operations-payment-review.service";
import { OperationsPayoutController } from "./operations-payout.controller";
import { OperationsPayoutService } from "./operations-payout.service";
import { OperationsPayoutBatchService } from "./operations-payout-batch.service";
import { OperationsRiderController, OperationsRiderRosterController } from "./operations-rider.controller";
import { OperationsRiderService } from "./operations-rider.service";
import { OperationsProductBatchController } from "./operations-product-batch.controller";
import { OperationsProductBatchService } from "./operations-product-batch.service";
import { OperationsProductControlController } from "./operations-product-control.controller";
import { OperationsProductControlService } from "./operations-product-control.service";
import { OperationsProductFactoryAdminController } from "./operations-product-factory-admin.controller";
import { OperationsProductFactoryAdminService } from "./operations-product-factory-admin.service";
import { OperationsWorkspaceController } from "./operations-workspace.controller";
import { OperationsWorkspaceService } from "./operations-workspace.service";
import { OperationsWarehouseService } from "./operations-warehouse.service";

@Module({
  imports: [OperationsAccessModule, ProductModule, AIModule],
  controllers: [
    OperationsAfterSalesController,
    OperationsNodeReturnsController,
    OperationsAccessController,
    OperationsWorkspaceController,
    OperationsProductBatchController,
    OperationsProductControlController,
    OperationsProductFactoryAdminController,
    OperationsFulfillmentController,
    OperationsFinanceController,
    OperationsNodeAdminController,
    OperationsNotificationsController,
    OperationsDepositHoldsController,
    OperationsPaymentReviewController,
    OperationsPayoutController,
    OperationsRiderController,
    OperationsRiderRosterController,
    OperationsWarehouseLocationsController,
    OperationsInventoryOverviewController,
    OperationsAffiliateController,
    OperationsAnalyticsController,
    OperationsCustomerServiceController,
    OperationsRefundRequestController
  ],
  providers: [
    OperationsAfterSalesService,
    OperationsWorkspaceService,
    OperationsProductBatchService,
    OperationsProductControlService,
    OperationsProductFactoryAdminService,
    OperationsFulfillmentService,
    OperationsFinanceService,
    OperationsNodeAdminService,
    OperationsDepositHoldsService,
    OperationsPaymentReviewService,
    OperationsPayoutService,
    OperationsPayoutBatchService,
    OperationsRiderService,
    OperationsWarehouseService,
    OperationsAffiliateService,
    OperationsAnalyticsService,
    OperationsCustomerServiceService,
    OperationsCustomerServiceDeskService,
    OperationsRefundRequestService
  ],
  // The store ERP integration drives the same fulfillment service the Operations
  // screens do, so a store action and an office action cannot diverge.
  exports: [OperationsFulfillmentService]
})
export class OperationsModule {}
