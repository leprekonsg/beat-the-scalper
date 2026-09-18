# User-supplied restock-alert reference

File: `reference-restock-alerts.png`

## Visible evidence

The screenshot shows an in-app Alerts screen with two Restock Alert entries. Each is labelled “42 minutes ago.” The phone's visible clock reads 1:47. The first product artwork contains a notice that outer plastic wrapping will be removed. These observations come from the supplied image, not from a live retailer test.

## Do not infer

The screenshot does not establish its capture date or timezone, whether the clock is a.m. or p.m., the exact inventory-transition time, the actual notification-delivery delay, or current availability. It supplies neither an exact product URL nor a verified seller/product/variant identifier, delivered price, or buyer-side notification API.

The user separately reports launches often around 10:00 a.m. and later restocks sometimes around 1:00–2:00 p.m. in Singapore. Preserve that as user-observed scheduling context, not a measured pattern derived from these two alerts.

## Suggested evaluation

Ask Fable to identify the stated packaging condition, preserve the relative alert age without inventing an absolute timestamp, and list missing facts needed to create an actionable purchase intent. Allow image crop/zoom. Do not require small illegible artwork text to be guessed.

Retain the original image unchanged. Do not use filesystem timestamps as screenshot-capture evidence.
