import Darwin
import Foundation
import Observation
import os

/// App-side timings (ticket 13). Each mark is an `OSSignposter` interval (visible in Instruments)
/// and, under `-MCPerfProbe YES`, a sample the UI test reads from an invisible probe element.
@MainActor
enum Perf {
	static let signposter = OSSignposter(subsystem: "io.examplebusiness.mailclaw", category: "perf")
	/// Also in Release: apple/scripts/launch-time.sh reads launch_rows_ms from the log.
	private static let log = Logger(subsystem: "io.examplebusiness.mailclaw", category: "perf")
	private static var started: [String: (ContinuousClock.Instant, OSSignpostIntervalState)] = [:]
	private static var launchRecorded = false

	static func begin(_ name: StaticString, key: String) {
		started[key] = (.now, signposter.beginInterval(name, id: signposter.makeSignpostID()))
	}

	/// Ends the interval `key` once the UI has committed the frame that shows the result.
	static func end(_ name: StaticString, key: String, sample: String) {
		guard let (start, state) = started.removeValue(forKey: key) else { return }
		afterNextCommit {
			signposter.endInterval(name, state)
			PerfProbe.shared.add(sample, ms: (ContinuousClock.now - start).milliseconds)
		}
	}

	/// Process start (fork/exec, before dyld) to the first frame with list rows.
	static func launchRowsShown(fromCache: Bool) {
		guard !launchRecorded else { return }
		launchRecorded = true
		afterNextCommit {
			let ms = (Date().timeIntervalSince1970 - processStart) * 1000
			log.info("launch_rows_ms \(ms, format: .fixed(precision: 0), privacy: .public) cache \(fromCache, privacy: .public)")
			signposter.emitEvent("launch_rows")
			PerfProbe.shared.add(fromCache ? "launch_rows_cache_ms" : "launch_rows_network_ms", ms: ms)
		}
	}

	/// Two main-queue hops: the first runs in the current run-loop turn, SwiftUI commits at the end
	/// of that turn, the second runs after the commit.
	static func afterNextCommit(_ body: @escaping @MainActor () -> Void) {
		DispatchQueue.main.async {
			DispatchQueue.main.async { MainActor.assumeIsolated { body() } }
		}
	}

	private static let processStart: TimeInterval = {
		var info = kinfo_proc()
		var size = MemoryLayout<kinfo_proc>.stride
		var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
		guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return Date().timeIntervalSince1970 }
		let start = info.kp_proc.p_un.__p_starttime
		return TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000
	}()
}

/// Longest main-thread stall since `start()` (ticket 13, failure mode 7: "a huge body freezes the
/// UI"). A 50 ms common-mode timer; any extra delay between ticks is time the main thread was busy.
@MainActor
final class StallWatch {
	static let shared = StallWatch()
	private var timer: Timer?
	private var last = CFAbsoluteTimeGetCurrent()
	private var worst = 0.0

	func start() {
		guard LaunchOptions.perfProbe, timer == nil else { return }
		last = CFAbsoluteTimeGetCurrent()
		let timer = Timer(timeInterval: 0.05, repeats: true) { _ in MainActor.assumeIsolated { StallWatch.shared.tick() } }
		RunLoop.main.add(timer, forMode: .common)
		self.timer = timer
	}

	private func tick() {
		let now = CFAbsoluteTimeGetCurrent()
		let stall = max(0, (now - last - 0.05) * 1000)
		last = now
		if stall > worst {
			worst = stall
			PerfProbe.shared.set("main_stall_max_ms", ms: stall)
		}
	}
}

@MainActor @Observable
final class PerfProbe {
	static let shared = PerfProbe()
	private(set) var samples: [String: [Double]] = [:]

	func add(_ key: String, ms: Double) {
		samples[key, default: []].append((ms * 10).rounded() / 10)
	}

	func set(_ key: String, ms: Double) {
		samples[key] = [(ms * 10).rounded() / 10]
	}

	var json: String {
		guard let data = try? JSONSerialization.data(withJSONObject: samples, options: [.sortedKeys]) else { return "{}" }
		return String(decoding: data, as: UTF8.self)
	}
}

extension Duration {
	var milliseconds: Double {
		Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
	}
}
