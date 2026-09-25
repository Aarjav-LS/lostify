CREATE TABLE `lost_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reporterId` int NOT NULL,
	`type` enum('lost','found') NOT NULL,
	`title` varchar(180) NOT NULL,
	`description` text NOT NULL,
	`category` varchar(80) NOT NULL,
	`location` varchar(160) NOT NULL,
	`dateOccurred` timestamp NOT NULL,
	`contactEmail` varchar(320) NOT NULL,
	`photoUrl` text,
	`photoKey` text,
	`status` enum('pending','approved','claimed','rejected') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lost_items_id` PRIMARY KEY(`id`)
);
