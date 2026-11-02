// swift-tools-version: 6.2
// MailClawKit: the API client, local store and sync behind the native app (ticket 13).
import PackageDescription

let package = Package(
	name: "MailClawKit",
	platforms: [.iOS("26.0"), .macOS("27.0")],
	products: [.library(name: "MailClawKit", targets: ["MailClawKit"])],
	dependencies: [
		// Pinned exactly so a regenerated project builds the same bytes.
		.package(url: "https://github.com/groue/GRDB.swift", exact: "7.11.1"),
	],
	targets: [
		.target(
			name: "MailClawKit",
			dependencies: [.product(name: "GRDB", package: "GRDB.swift")]
		),
	]
)
