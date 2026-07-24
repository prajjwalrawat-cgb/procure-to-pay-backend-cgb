import { ForbiddenException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolves the Vendor a logged-in vendor-portal user belongs to (Slice 4
 * pattern). The vendor is derived from the user's contact record — never
 * trusted from request input — so a vendor JWT can only ever act for its own
 * vendor (Master Context §3 rule #11).
 */
@Injectable()
export class VendorResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveVendorId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new ForbiddenException('Not a vendor account');
    const contact = await this.prisma.client.vendorContact.findFirst({
      where: { email: user.email },
      select: { vendorId: true },
    });
    if (!contact) throw new ForbiddenException('No vendor linked to this account');
    return contact.vendorId;
  }
}
