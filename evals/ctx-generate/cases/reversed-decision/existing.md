tags: orders, shopify, sqs, concurrency
## Goal
Stop duplicate fulfillments created when the same Shopify order is initialised twice.
## Key files
- packages/functions/src/handler/order.ts: addShopifyOrder
- stacks/QueueStack.ts: shopifyOrderStoreInDbQueue
## Decisions
- Switch shopifyOrderStoreInDbQueue to a FIFO queue keyed on order id to serialize inits.
## State
- 36 duplicate root fulfillments all-time; ~51% of lines have duplicate CREATED line_item_state rows
## Next step
- Change the queue to FIFO in QueueStack.ts and add a MessageGroupId
