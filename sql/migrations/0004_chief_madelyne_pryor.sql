ALTER TABLE `lost_items` ADD `claimRequestStatus` enum('pending','approved','rejected');--> statement-breakpoint
ALTER TABLE `lost_items` ADD `claimRequestedBy` int;--> statement-breakpoint
ALTER TABLE `lost_items` ADD `claimMessage` text;