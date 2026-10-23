import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import { AffiliateLinkType, AffiliateStatus } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsAffiliateService, type CommissionQueueKey } from "./operations-affiliate.service";

type AffiliateBody = {
  adminUserId?: string;
  customerId?: string;
  affiliateCode?: string;
  displayName?: string;
  phone?: string;
  email?: string;
  commissionRateBps?: number;
};

type AffiliateUpdateBody = {
  adminUserId?: string;
  status?: AffiliateStatus;
  commissionRateBps?: number | null;
};

type LinkBody = {
  adminUserId?: string;
  affiliateId?: string;
  affiliateCode?: string;
  type?: AffiliateLinkType;
  productId?: string;
  productCode?: string;
  collectionId?: string;
  source?: string;
  placement?: string;
  campaign?: string;
  landingPath?: string;
};

type CommissionActionBody = {
  adminUserId?: string;
  note?: string;
};

@Controller("operations/affiliate")
export class OperationsAffiliateController {
  constructor(private readonly affiliate: OperationsAffiliateService, private readonly access: OperationsAccessService) {}

  @Get("summary")
  async summary(@Headers("authorization") authorization?: string) {
    return this.affiliate.summary(await this.access.requireAccessToken(authorization));
  }

  @Get("affiliates")
  async affiliates(@Headers("authorization") authorization?: string) {
    return this.affiliate.listAffiliates(await this.access.requireAccessToken(authorization));
  }

  @Post("affiliates")
  async createAffiliate(@Headers("authorization") authorization: string | undefined, @Body() body: AffiliateBody) {
    return this.affiliate.createAffiliate(await this.authorizedInput(authorization, body));
  }

  @Get("customers/search")
  async searchCustomers(@Query("q") query?: string, @Headers("authorization") authorization?: string) {
    return this.affiliate.searchCustomers(await this.access.requireAccessToken(authorization), query);
  }

  @Post("customers/:customerId/enable-affiliate")
  async enableCustomerAffiliate(@Param("customerId") customerId: string, @Headers("authorization") authorization: string | undefined, @Body() body: AffiliateBody) {
    return this.affiliate.enableCustomerAffiliate(customerId, await this.authorizedInput(authorization, body));
  }

  @Patch("affiliates/:affiliateId")
  async updateAffiliate(@Param("affiliateId") affiliateId: string, @Headers("authorization") authorization: string | undefined, @Body() body: AffiliateUpdateBody) {
    return this.affiliate.updateAffiliate(affiliateId, await this.authorizedInput(authorization, body));
  }

  @Get("links")
  async links(@Headers("authorization") authorization?: string) {
    return this.affiliate.listLinks(await this.access.requireAccessToken(authorization));
  }

  @Post("links")
  async createLink(@Headers("authorization") authorization: string | undefined, @Body() body: LinkBody) {
    return this.affiliate.createLink(await this.authorizedInput(authorization, body));
  }

  @Get("clicks")
  async clicks(@Headers("authorization") authorization?: string) {
    return this.affiliate.listClicks(await this.access.requireAccessToken(authorization));
  }

  @Get("attributed-orders")
  async attributedOrders(@Headers("authorization") authorization?: string) {
    return this.affiliate.listAttributedOrders(await this.access.requireAccessToken(authorization));
  }

  @Get("commissions")
  async commissions(@Query("queue") queue?: CommissionQueueKey, @Headers("authorization") authorization?: string) {
    return this.affiliate.listCommissions(queue, await this.access.requireAccessToken(authorization));
  }

  @Post("commissions/:commissionId/confirm")
  async confirmCommission(@Param("commissionId") commissionId: string, @Headers("authorization") authorization: string | undefined, @Body() body: CommissionActionBody) {
    return this.affiliate.confirmCommission(commissionId, await this.authorizedInput(authorization, body));
  }

  @Post("commissions/:commissionId/reject")
  async rejectCommission(@Param("commissionId") commissionId: string, @Headers("authorization") authorization: string | undefined, @Body() body: CommissionActionBody) {
    return this.affiliate.rejectCommission(commissionId, await this.authorizedInput(authorization, body));
  }

  @Post("commissions/:commissionId/paid")
  async markCommissionPaid(@Param("commissionId") commissionId: string, @Headers("authorization") authorization: string | undefined, @Body() body: CommissionActionBody) {
    return this.affiliate.markCommissionPaid(commissionId, await this.authorizedInput(authorization, body));
  }

  @Get("payout-export")
  async payoutExport(@Headers("authorization") authorization?: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.affiliate.payoutExport(await this.access.requireAccessToken(authorization), { from, to });
  }

  @Get("commission-setting")
  async commissionSetting(@Headers("authorization") authorization?: string) {
    return this.affiliate.commissionSetting(await this.access.requireAccessToken(authorization));
  }
  private async authorizedInput<T extends { adminUserId?: string }>(authorization: string | undefined, input: T): Promise<T> {
    return { ...input, adminUserId: await this.access.requireAccessToken(authorization) };
  }
}
