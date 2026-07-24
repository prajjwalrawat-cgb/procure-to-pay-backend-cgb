-- CreateIndex
CREATE INDEX "Invoice_tenant_id_receivedAt_idx" ON "Invoice"("tenant_id", "receivedAt");
