# Core Data Model

This document defines the MVP logical data model. It is not yet a full Prisma
schema, but it is detailed enough to guide table design, migrations, API
contracts, permissions, and tests.

## Modeling Principles

- One second-hand clothing item equals one product and one inventory item.
- Product content readiness and inventory sale readiness are separate.
- Payment, order, inventory, fulfillment, return, and commission states are separate.
- Prices and fees are snapshotted on orders and order items.
- AI raw values must be preserved separately from human final values.
- Every high-risk change must write an audit log.
- All money values are stored in integer KSh cents or integer KSh. The MVP may
  use integer KSh if no sub-shilling precision is needed.
- Public display codes are separate from internal database ids.
- Soft deletion is preferred for business records.

## Entity Relationship Summary

```text
Employee --< AuditLog
Employee --< ProductReview

Customer --< Order
Customer --< Address
Customer --< ReturnRequest

Affiliate --< AffiliateLink
Affiliate --< Attribution
Affiliate --< CommissionLedger
Affiliate --< CommissionSettlementBatch

Product --< ProductImage
Product --< ProductMeasurement
Product --< AIExtraction
Product --< ProductReview
Product --1 InventoryItem
Product --< OrderItem

InventoryLocation --< InventoryItem
InventoryItem --< InventoryMovement
InventoryItem --< Reservation
InventoryItem --< PickingScan

Order --< OrderItem
Order --< Payment
Order --< FulfillmentTask
Order --< Shipment
Order --< ReturnRequest
Order --< CommissionLedger

Payment --< MpesaCallback
Payment --< Refund

ReturnRequest --< ReturnEvidence
ReturnRequest --1 ReturnInspection

CommissionSettlementBatch --< CommissionLedger
```

## Foundation Module

### Employee

Internal system user.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `employeeCode` | Public internal code, unique. |
| `name` | Employee name. |
| `phone` | Login or contact phone, unique when used for login. |
| `status` | `ACTIVE`, `SUSPENDED`, `LEFT`. |
| `createdAt`, `updatedAt` | Timestamps. |

### Role

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `code` | Unique role code, for example `PRODUCT_REVIEWER`. |
| `name` | Display name. |
| `description` | Role purpose. |

### Permission

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `code` | Unique permission code. |
| `module` | Owner module. |
| `description` | Permission description. |

### EmployeeRole

Join table between employees and roles.

### AuditLog

Required for all high-risk operations.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `actorType` | `EMPLOYEE`, `SYSTEM`, `CUSTOMER`, `AFFILIATE`. |
| `actorId` | Nullable for system. |
| `sourceApp` | `STOREFRONT`, `OPERATIONS`, `ADMIN`, `API`, `WORKER`. |
| `module` | Owner module. |
| `entityType` | Example `PRODUCT`, `ORDER`, `PAYMENT`. |
| `entityId` | Related record id. |
| `action` | Action code. |
| `beforeJson` | Optional prior values. |
| `afterJson` | Optional new values. |
| `reason` | Required for manual exceptions. |
| `createdAt` | Timestamp. |

### SystemSetting

Stores configurable MVP settings such as reservation minutes and delivery fee.

| Field | Notes |
| --- | --- |
| `key` | Unique string. |
| `valueJson` | Typed value. |
| `scope` | `GLOBAL`, `STAGING`, `PRODUCTION`. |
| `updatedByEmployeeId` | Nullable system actor. |

## Customer Module

### Customer

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `customerCode` | Public customer code. |
| `name` | Customer name. |
| `phone` | Unique normalized phone. |
| `status` | `ACTIVE`, `BLOCKED`. |
| `createdAt`, `updatedAt` | Timestamps. |

### Address

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `customerId` | FK to Customer. |
| `label` | Optional display label. |
| `area` | Example `Kikuyu`. |
| `line1`, `line2` | Address details. |
| `landmark` | Local delivery landmark. |
| `latitude`, `longitude` | Optional. |
| `isDefault` | Boolean. |

## Product Module

### Product

Digital product record for one physical item.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productCode` | Public product code, unique, for example `DLF-26-000001`. |
| `barcode` | Nullable until human calibration is complete; unique formal barcode assigned before review. |
| `title` | Generated or reviewed title. |
| `category` | Controlled category. |
| `gender` | `WOMEN`, `MEN`, `KIDS`, `UNISEX`, nullable. |
| `color` | Controlled color. |
| `brand` | Optional. |
| `tagSize` | Size shown on label, optional. |
| `finalSizeLabel` | Platform size label after review. |
| `conditionGrade` | Controlled condition grade. |
| `priceKsh` | Current platform price. |
| `status` | Product state machine status. |
| `publishedAt` | Nullable. |
| `unpublishedAt` | Nullable. |
| `createdByEmployeeId` | FK to Employee. |
| `approvedByEmployeeId` | Nullable FK to Employee. |
| `createdAt`, `updatedAt` | Timestamps. |

Suggested unique constraints:

- `productCode`
- `barcode` when present

Suggested indexes:

- `(status, publishedAt)`
- `(category, finalSizeLabel, priceKsh)`
- `(conditionGrade)`

### ProductImage

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | FK to Product. |
| `type` | `FRONT`, `BACK`, `LABEL`, `DEFECT`, `DETAIL`, `SOCIAL_CARD`. |
| `originalUrl` | Private original file. |
| `publicUrl` | Public compressed file if customer-safe. |
| `sortOrder` | Display order. |
| `isRequired` | Boolean. |
| `uploadedByEmployeeId` | FK to Employee. |
| `createdAt` | Timestamp. |

### ProductMeasurement

Stores AI values and final human values separately.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | FK to Product. |
| `measurementType` | `SHOULDER`, `CHEST`, `WAIST`, `HIP`, `LENGTH`, `SLEEVE`, `INSEAM`, etc. |
| `aiValueCm` | Nullable decimal. |
| `aiConfidence` | Nullable decimal 0-1. |
| `finalValueCm` | Human-approved value. |
| `finalSource` | `AI_ACCEPTED`, `HUMAN_EDITED`, `HUMAN_ENTERED`. |
| `reviewedByEmployeeId` | Nullable FK to Employee. |
| `reviewedAt` | Nullable timestamp. |

Unique constraint:

- `(productId, measurementType)`

### AIExtraction

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | FK to Product. |
| `provider` | AI provider. |
| `model` | Model name. |
| `inputImageIds` | JSON array of ProductImage ids. |
| `rawOutputJson` | Full raw extraction. |
| `normalizedOutputJson` | Normalized fields. |
| `status` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`. |
| `errorMessage` | Nullable. |
| `createdAt`, `completedAt` | Timestamps. |

### ProductDefect

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | FK to Product. |
| `defectType` | Controlled defect type. |
| `severity` | `MINOR`, `MAJOR`. |
| `description` | Internal and optional customer-safe text. |
| `imageId` | Nullable FK to ProductImage. |

### ProductReview

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | FK to Product. |
| `reviewerEmployeeId` | FK to Employee. |
| `result` | `APPROVED`, `REWORK_REQUIRED`, `REJECTED`. |
| `reason` | Required for non-approved. |
| `createdAt` | Timestamp. |

## Inventory Module

### InventoryLocation

Physical online inventory location.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `locationCode` | Unique code, for example `ON-KKY-C03-B07`. |
| `siteCode` | Example `KKY`. |
| `containerCode` | Cage, rack, bag, or bin code. |
| `capacityItems` | Target capacity. |
| `status` | `ACTIVE`, `FULL`, `INACTIVE`, `BLOCKED`. |
| `createdAt`, `updatedAt` | Timestamps. |

### InventoryItem

One physical item inventory record.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `productId` | Unique FK to Product. |
| `barcode` | Unique barcode copy for scan lookup. |
| `currentLocationId` | Nullable FK to InventoryLocation. |
| `status` | Inventory state. |
| `onlineStockBatch` | Example `MVP1000`. |
| `checkedInByEmployeeId` | Nullable FK. |
| `checkedInAt` | Nullable timestamp. |
| `updatedAt` | Timestamp. |

Unique constraint:

- `productId`
- `barcode`

### InventoryMovement

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `inventoryItemId` | FK to InventoryItem. |
| `fromLocationId` | Nullable FK. |
| `toLocationId` | Nullable FK. |
| `movementType` | `CHECK_IN`, `MOVE`, `PICK`, `RETURN`, `COUNT_ADJUSTMENT`, `HOLD`, `RELEASE`. |
| `reason` | Required for exceptions. |
| `employeeId` | Nullable system actor. |
| `createdAt` | Timestamp. |

### Reservation

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `reservationCode` | Public/internal code. |
| `inventoryItemId` | FK to InventoryItem. |
| `orderId` | FK to Order. |
| `customerPhone` | Normalized phone. |
| `status` | Reservation state. |
| `expiresAt` | 15 minutes after creation. |
| `createdAt`, `updatedAt` | Timestamps. |

Indexes:

- `(inventoryItemId, status)`
- `(customerPhone, status)`
- `(expiresAt, status)`

## Transaction Module

### Order

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `orderCode` | Public order code, unique. |
| `customerId` | FK to Customer. |
| `status` | Order state. |
| `fulfillmentMethod` | `PICKUP`, `DELIVERY`. |
| `deliveryFeeKsh` | Price snapshot. |
| `subtotalKsh` | Item total snapshot. |
| `totalKsh` | Subtotal plus fees minus discounts. |
| `referralCode` | Captured referral code, nullable. |
| `attributionId` | Nullable FK to Attribution. |
| `customerNameSnapshot` | Snapshot. |
| `customerPhoneSnapshot` | Snapshot. |
| `deliveryAddressSnapshotJson` | Nullable. |
| `createdAt`, `updatedAt` | Timestamps. |

### OrderItem

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `orderId` | FK to Order. |
| `productId` | FK to Product. |
| `inventoryItemId` | FK to InventoryItem. |
| `productCodeSnapshot` | Product code at order time. |
| `titleSnapshot` | Product title at order time. |
| `priceKsh` | Price snapshot. |
| `status` | `ORDERED`, `CANCELLED`, `RETURNED`, `REFUNDED`. |

Unique constraint:

- `inventoryItemId` can appear in at most one active paid order. Implement with transaction logic and indexes appropriate to PostgreSQL.

## Payment Module

### Payment

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `paymentCode` | Public/internal payment code. |
| `orderId` | FK to Order. |
| `provider` | `MPESA`. |
| `amountKsh` | Expected amount. |
| `status` | Payment state. |
| `idempotencyKey` | Unique for initiation. |
| `providerCheckoutRequestId` | M-Pesa checkout id, nullable. |
| `providerMerchantRequestId` | M-Pesa merchant request id, nullable. |
| `providerReceiptNumber` | M-Pesa receipt, nullable unique when present. |
| `phone` | Payer phone. |
| `initiatedAt`, `completedAt` | Timestamps. |
| `createdAt`, `updatedAt` | Timestamps. |

### MpesaCallback

Stores every callback attempt.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `paymentId` | Nullable FK to Payment. |
| `providerCheckoutRequestId` | Lookup field. |
| `providerReceiptNumber` | Nullable. |
| `rawPayloadJson` | Full callback. |
| `resultCode` | Provider result. |
| `processedStatus` | `PROCESSED`, `DUPLICATE`, `UNMATCHED`, `AMOUNT_MISMATCH`, `ERROR`. |
| `createdAt` | Timestamp. |

Unique where available:

- `providerReceiptNumber`
- callback event id if provider supplies one

### Refund

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `refundCode` | Unique code. |
| `paymentId` | FK to Payment. |
| `orderId` | FK to Order. |
| `returnRequestId` | Nullable FK. |
| `amountKsh` | Refund amount. |
| `status` | `REQUESTED`, `APPROVED`, `PROCESSING`, `REFUNDED`, `FAILED`, `REJECTED`. |
| `reason` | Required. |
| `approvedByEmployeeId` | Nullable FK. |
| `executedByEmployeeId` | Nullable FK. |
| `createdAt`, `updatedAt` | Timestamps. |

## Fulfillment and Returns Module

### FulfillmentTask

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `taskCode` | Unique task code. |
| `orderId` | FK to Order. |
| `type` | `PICK`, `PACK`, `PICKUP`, `DELIVERY_HANDOFF`, `RETURN_INSPECTION`. |
| `status` | Task state. |
| `assignedEmployeeId` | Nullable FK. |
| `startedAt`, `completedAt` | Nullable timestamps. |

### PickingScan

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `fulfillmentTaskId` | FK to FulfillmentTask. |
| `orderItemId` | FK to OrderItem. |
| `scannedLocationId` | Nullable FK. |
| `scannedBarcode` | Scanned value. |
| `result` | `MATCH`, `WRONG_LOCATION`, `WRONG_ITEM`, `NOT_FOUND`. |
| `employeeId` | FK to Employee. |
| `createdAt` | Timestamp. |

### Parcel

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `parcelCode` | Unique parcel code. |
| `orderId` | FK to Order. |
| `status` | `PACKING`, `PACKED`, `HANDED_OFF`, `DELIVERED`, `FAILED`. |
| `packedByEmployeeId` | Nullable FK. |
| `packedAt` | Nullable. |

### Shipment

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `shipmentCode` | Unique code. |
| `orderId` | FK to Order. |
| `parcelId` | FK to Parcel. |
| `method` | `PICKUP`, `LOCAL_DELIVERY`. |
| `status` | Fulfillment delivery state. |
| `deliveryFeeKsh` | Snapshot. |
| `riderName` | Nullable. |
| `riderPhone` | Nullable. |
| `pickupCode` | Nullable. |
| `deliveredAt` | Nullable timestamp. |

### DeliveryAttempt

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `shipmentId` | FK to Shipment. |
| `attemptNumber` | 1, 2, etc. |
| `result` | `DELIVERED`, `CUSTOMER_UNREACHABLE`, `BAD_ADDRESS`, `REFUSED`, `OTHER_FAILED`. |
| `notes` | Optional. |
| `createdAt` | Timestamp. |

### ReturnRequest

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `returnCode` | Unique code. |
| `orderId` | FK to Order. |
| `customerId` | FK to Customer. |
| `reasonCode` | Controlled return reason. |
| `description` | Customer or staff notes. |
| `status` | Return state. |
| `requestedAt` | Timestamp. |
| `decisionByEmployeeId` | Nullable FK. |
| `decisionAt` | Nullable timestamp. |

### ReturnEvidence

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `returnRequestId` | FK to ReturnRequest. |
| `fileUrl` | Private evidence file. |
| `type` | `PHOTO`, `VIDEO`, `NOTE`. |
| `createdAt` | Timestamp. |

### ReturnInspection

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `returnRequestId` | Unique FK to ReturnRequest. |
| `receivedBarcode` | Scanned barcode. |
| `result` | `ACCEPTED_RESELLABLE`, `ACCEPTED_DAMAGED`, `REJECTED_MISMATCH`. |
| `inspectedByEmployeeId` | FK to Employee. |
| `notes` | Optional. |
| `createdAt` | Timestamp. |

## Affiliate and Commission Module

### Affiliate

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `affiliateCode` | Public code, unique. |
| `name` | Affiliate name. |
| `phone` | M-Pesa and contact phone. |
| `status` | `PENDING`, `ACTIVE`, `SUSPENDED`, `REJECTED`. |
| `mpesaPhone` | Payout phone. |
| `createdAt`, `updatedAt` | Timestamps. |

### AffiliateLink

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `affiliateId` | FK to Affiliate. |
| `productId` | Nullable FK to Product. Null means store-level link. |
| `refCode` | Referral code in URL. |
| `urlPath` | Link target path. |
| `status` | `ACTIVE`, `DISABLED`. |
| `createdAt` | Timestamp. |

### Attribution

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `affiliateId` | FK to Affiliate. |
| `customerId` | Nullable FK to Customer. |
| `customerPhone` | Nullable if anonymous at click time. |
| `refCode` | Captured referral code. |
| `source` | `WHATSAPP`, `FACEBOOK`, `INSTAGRAM`, `TIKTOK`, `QR`, `MANUAL`, `OTHER`. |
| `landingPath` | First path. |
| `status` | Attribution state. |
| `expiresAt` | Click time plus 7 days. |
| `createdAt` | Timestamp. |

### CommissionRule

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `code` | Unique code. |
| `type` | `FIXED_AMOUNT`, `PERCENTAGE`. |
| `value` | Rule value. |
| `category` | Optional scope. |
| `productId` | Optional scope. |
| `status` | `ACTIVE`, `INACTIVE`. |

### CommissionLedger

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `affiliateId` | FK to Affiliate. |
| `orderId` | FK to Order. |
| `orderItemId` | FK to OrderItem. |
| `commissionRuleId` | FK to CommissionRule. |
| `amountKsh` | Commission amount. |
| `status` | Commission state. |
| `eligibleAt` | Delivery plus 72 hours (the return window; 24 hours before 2026-10-14). |
| `confirmedAt` | Nullable. |
| `paidAt` | Nullable. |
| `reversalReason` | Nullable. |
| `createdAt`, `updatedAt` | Timestamps. |

Unique constraint:

- `(orderItemId, affiliateId)` for active non-reversed commission.

### CommissionSettlementBatch

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `batchCode` | Unique code. |
| `periodStart`, `periodEnd` | Settlement window. |
| `status` | `DRAFT`, `APPROVED`, `PAYING`, `PAID`, `FAILED`. |
| `totalAmountKsh` | Batch total. |
| `approvedByEmployeeId` | Nullable FK. |
| `paidByEmployeeId` | Nullable FK. |
| `createdAt`, `updatedAt` | Timestamps. |

## Data Operations Module

### AnalyticsEvent

MVP event table for funnel and operating metrics.

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `eventName` | Example `product_viewed`. |
| `sourceApp` | `STOREFRONT`, `OPERATIONS`, `ADMIN`. |
| `customerId` | Nullable. |
| `affiliateId` | Nullable. |
| `employeeId` | Nullable. |
| `productId` | Nullable. |
| `orderId` | Nullable. |
| `propertiesJson` | Event properties. |
| `createdAt` | Timestamp. |

Suggested indexes:

- `(eventName, createdAt)`
- `(productId, eventName, createdAt)`
- `(affiliateId, eventName, createdAt)`

### CustomerServiceTicket

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `ticketCode` | Unique code. |
| `customerId` | Nullable FK. |
| `orderId` | Nullable FK. |
| `channel` | `WHATSAPP`, `PHONE`, `IN_PERSON`, `OTHER`. |
| `category` | `PRE_SALE`, `PAYMENT`, `FULFILLMENT`, `RETURN`, `COMPLAINT`, `OTHER`. |
| `status` | `OPEN`, `PENDING_CUSTOMER`, `RESOLVED`, `ESCALATED`. |
| `assignedEmployeeId` | Nullable FK. |
| `notes` | Internal notes. |
| `createdAt`, `updatedAt` | Timestamps. |

## Required Constraints and Invariants

### Product and Inventory

- Product barcode is globally unique.
- Inventory item barcode is globally unique.
- Product barcode is assigned after human calibration, before review and inventory check-in.
- One product has at most one inventory item.
- Published product must have customer-safe public images.
- Available inventory must have a location.

### Reservation and Order

- Only one active reservation per inventory item.
- A phone may have at most 5 active reservations.
- Order total equals item snapshots plus fees minus discounts.
- Paid order cannot contain an item still marked `AVAILABLE`.

### Payment

- Payment idempotency key is unique.
- Provider receipt number is unique when present.
- Payment amount must match order total unless admin review approves exception.

### Fulfillment

- Picked item barcode must match order item barcode.
- Packed item must be scanned after picking.
- Delivered order can trigger commission confirmation timer.

### Affiliate

- Last valid attribution wins.
- Attribution expires after 7 days.
- Commission is one level only.
- Refunded item reverses related commission.

## Implementation Sequence

1. Implement Foundation entities first.
2. Implement Product and media entities.
3. Implement Inventory location and item entities.
4. Implement Reservation and Order entities together.
5. Implement Payment and M-Pesa callback entities.
6. Implement Fulfillment and Return entities.
7. Implement Affiliate and Commission entities.
8. Implement AnalyticsEvent and dashboards.

## Open Modeling Decisions

These decisions require approval before schema implementation:

1. Whether money values use integer KSh or integer cents.
2. Whether customer OTP login is required before first order or only after order lookup.
3. Whether commission is fixed amount per item, percentage, or both in MVP.
4. Whether social material images are stored as `ProductImage` or a separate `MarketingAsset`.
5. Whether support tickets live in MVP or start as admin notes on order records.
