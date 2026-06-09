CREATE UNIQUE INDEX one_succeeded_payment_per_order
ON "Payment" ("orderId") WHERE status = 'SUCCEEDED';