import Foundation

/// Explicit local capture identity, never an authenticated account or backend grant.
/// Device installs opt in at compile time so every launch (including location wake) stays offline.
/// Ordinary and Release builds cannot inherit the pilot from persisted preferences on a phone.
enum OfflinePilot {
    static var enabled: Bool {
        #if DEBUG && os(iOS)
        #if MILEAGE_OFFLINE_PILOT
        return true
        #elseif targetEnvironment(simulator)
        return UserDefaults.standard.bool(forKey: "MCMileageOfflinePilot")
        #else
        return false
        #endif
        #else
        return false
        #endif
    }
    static let owner = "local-only-device-capture-v1"
}
