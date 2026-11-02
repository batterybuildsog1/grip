import Foundation
import CoreLocation

/// `GET /api/mileage/report?month=YYYY-MM` (docs/mileage/V3-CONTRACT.md): one call renders the whole
/// Mileage view. Every figure, prompt and place name on screen is the server's; the app never sums,
/// words a question or picks a name (V3: the web and the apps can't disagree).
struct MileageReport: Codable, Equatable, Sendable {
	let month: String
	let from: Int64
	let to: Int64
	let timezone: String
	let today: String
	/// The first trip's date: explains an empty earlier month ("Recording started Oct 1").
	let recording_started: String?
	/// Months that have trips, for the switcher.
	let months: [String]
	let companies: [Company]
	let rates: [RatePeriod]
	let totals: Totals
	/// "Needs you", in V3 order: newest first, a drive back right after its trip there.
	let queue: [String]
	/// Agent-filed trips, least sure first.
	let spot_check: [String]
	/// Every trip of the month, newest first.
	let trips: [Trip]

	struct Company: Codable, Equatable, Identifiable, Sendable {
		let id: String
		let name: String
		let treatment: String
		/// "none" (miles only) or "irs-estimate" (dollars at the IRS rate, "est.").
		let money: String
		/// Acme: each trip is reimbursable or not, each with its own total.
		let split_reimbursable: Bool
		var estimates: Bool { money == "irs-estimate" }
	}

	/// A dated IRS rate period. `to` is the day before the next period starts; nil = open-ended.
	struct RatePeriod: Codable, Equatable, Sendable, Identifiable {
		let from: String
		let to: String?
		let cents_per_mile: Double
		let source: String?
		var id: String { from }
	}

	struct Totals: Codable, Equatable, Sendable {
		let all_meters: Int
		let trips: Int
		let to_review: Int
		let agent_filed: Int
		/// The agent's guesses waiting for your yes, already inside the company figures.
		let proposed: Unassigned?
		let unassigned: Unassigned
		let companies: [CompanyTotal]
		struct Unassigned: Codable, Equatable, Sendable { let meters: Int; let trips: Int }
	}

	/// One company's figures. On-screen totals include the agent's proposals and say how much
	/// (`proposed_*`); the Side Co estimate is summed from each trip's rounded cents.
	struct CompanyTotal: Codable, Equatable, Sendable, Identifiable {
		let id: String
		let trips: Int
		let meters: Int
		let proposed_trips: Int?
		let proposed_meters: Int
		let reimbursable_meters: Int?
		let not_reimbursable_meters: Int?
		let proposed_reimbursable_meters: Int?
		let proposed_not_reimbursable_meters: Int?
		/// The Acme split's trip counts (the Report table's Trips).
		let reimbursable_trips: Int?
		let not_reimbursable_trips: Int?
		/// The same figures without the agent's guesses: what the default export holds.
		let confirmed: Confirmed?
		let estimate_usd: Double?
		let proposed_estimate_usd: Double?
		let rates_used: [RatePeriod]?
		/// Date ranges of this company's trips with no IRS rate set ("Set the IRS rate for …").
		let uncovered: [DateRange]?
	}

	struct Confirmed: Codable, Equatable, Sendable {
		let trips: Int
		let meters: Int
		let reimbursable_meters: Int?
		let not_reimbursable_meters: Int?
		let estimate_usd: Double?
		/// Filed trips the default export leaves out, by reason (rule A: a late start is counted, never left out).
		let left_out: [LeftOut]?
	}

	struct LeftOut: Codable, Equatable, Sendable {
		let reason: String
		let trips: Int
		let meters: Int
		let estimate_usd: Double?
	}

	struct DateRange: Codable, Equatable, Sendable { let from: String; let to: String }

	/// A trip view: the trip as every client shows it.
	struct Trip: Codable, Equatable, Identifiable, Sendable {
		let id: String
		let revision: Int
		let started_at: Int64
		let ended_at: Int64
		/// The zone the trip was driven in (its times are shown in it).
		let timezone: String?
		/// The trip's local date, YYYY-MM-DD.
		let date: String
		let minutes: Int
		let distance_meters: Int
		let quality: String
		/// Part of the drive wasn't recorded: drawn dashed, said in words.
		let gap: Gap?
		let start: End
		let end: End
		let company_id: String?
		let reimbursable: Bool?
		let purpose: String?
		/// filed (by you or confirmed), auto (the agent filed it), proposal (the agent's guess waits
		/// for your yes), ask (only you know).
		let state: State
		let set_by: SetBy?
		let proposal: Proposal?
		let auto: Basis?
		/// The question's words, made on the server so every client agrees.
		let prompt: String?
		/// A rail row's short words: the question in short ("Side Co or personal?") or "Filed: …".
		let rail_prompt: String?
		/// The one line on why it was filed, guessed or asked (null on a trip you filed).
		let reason: String?
		/// A drive back: the trip there, filed with the same answer when "also" is on.
		let return_of: String?
		let estimate_usd: Double?
		let cents_per_mile: Double?
		/// LATE-START: the start the phone didn't record, estimated from where the car was parked (Apple Maps).
		/// Already in `distance_meters` and the totals (the server counts; the app only says so).
		let start_estimate: MileageStartEstimate?

		enum State: String, Codable, Sendable { case filed, auto, proposal, ask }
		enum SetBy: String, Codable, Sendable { case you, agent }

		/// The stretch that wasn't recorded: `from_at`/`to_at` are the times (epoch ms) of its first
		/// and last route points, so every client dashes the same stretch. All null while the route
		/// isn't uploaded yet (a fresh capture with a restart): the gap is known, its size isn't.
		struct Gap: Codable, Equatable, Sendable {
			let meters: Int?
			let seconds: Int?
			let from_at: Int64?
			let to_at: Int64?
		}

		struct End: Codable, Equatable, Sendable {
			let lat: Double?
			let lng: Double?
			/// Null when the end has neither a name nor coordinates (nothing was recorded there).
			let name: String?
			/// saved · trip · agent · apple · address · coordinates.
			let name_source: String
			/// The agent's basis for its name: `{kind: "calendar", detail: "Location of your 9:45 AM event"}`.
			let name_basis: NameBasis?
			let address: String?
			let place_id: String?
			var coordinate: CLLocationCoordinate2D? {
				guard let lat, let lng else { return nil }
				return CLLocationCoordinate2D(latitude: lat, longitude: lng)
			}
		}

		struct NameBasis: Codable, Equatable, Sendable { let kind: String; let detail: String? }

		struct Proposal: Codable, Equatable, Sendable {
			let id: String
			/// Null on a guess that only names a place (a hint on a question, never a Yes).
			let company_id: String?
			let reimbursable: Bool?
			let purpose: String?
			let confidence: Double?
			let reason: String?
			let sources: [String]?
		}

		struct Basis: Codable, Equatable, Sendable {
			let confidence: Double?
			let reason: String?
			let sources: [String]?
		}

		var miles: Double { Double(distance_meters) / 1609.344 }
		var needsYou: Bool { state == .proposal || state == .ask }
	}

	func company(_ id: String?) -> Company? { companies.first { $0.id == id } }
	func total(_ id: String) -> CompanyTotal? { totals.companies.first { $0.id == id } }
	func trip(_ id: String) -> Trip? { trips.first { $0.id == id } }
}

/// Miles as the design writes them: one decimal ("42.5 mi").
enum MileageFormat {
	static func miles(_ meters: Int) -> String { String(format: "%.1f", Double(meters) / 1609.344) }
	static func usd(_ value: Double) -> String {
		let formatter = NumberFormatter()
		formatter.numberStyle = .currency
		formatter.currencyCode = "USD"
		formatter.locale = Locale(identifier: "en_US")
		return formatter.string(from: NSNumber(value: value)) ?? String(format: "$%.2f", value)
	}
	static func cents(_ value: Double) -> String {
		value.rounded() == value ? String(format: "%.0f¢/mi", value) : String(format: "%.1f¢/mi", value)
	}
}

/// Sentences that name companies, from the report's list (MILEAGE_COMPANIES_JSON plus the owner's):
/// each instance says its own companies. Never a literal name.
enum MileageCompanyWords {
	/// "A", "A and B", "A, B and C".
	static func list(_ names: [String]) -> String {
		guard let last = names.last else { return "" }
		return names.count == 1 ? last : names.dropLast().joined(separator: ", ") + " and " + last
	}

	/// Settings' IRS rate footer: "Side Co's estimate uses the rate of each trip's date. …".
	static func rateFooter(_ companies: [MileageReport.Company]) -> String {
		let last = "A date with no rate shows no estimate."
		let names = companies.filter(\.estimates).map(\.name)
		guard let only = names.first else { return last }
		if names.count == 1 {
			let owner = only.hasSuffix("s") ? "\(only)'" : "\(only)'s"
			return "\(owner) estimate uses the rate of each trip's date. \(last)"
		}
		return "Estimates for \(list(names)) use the rate of each trip's date. \(last)"
	}

	/// The 1 2 3 keys: the report's first three companies (Personal first), the list they file to.
	static func keys(_ companies: [MileageReport.Company]?, separator: String) -> String {
		guard let companies, !companies.isEmpty else { return "File as the first, second or third company" }
		return "File as " + companies.prefix(3).map(\.name).joined(separator: separator)
	}
}
