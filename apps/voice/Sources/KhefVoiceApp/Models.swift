import Foundation

struct ActiveSessionsResponse: Decodable {
    let sessions: [ActiveSession]
}

struct ActiveSessionLookupResponse: Decodable {
    let session: ActiveSession?
}

struct ActiveSession: Identifiable, Decodable, Hashable {
    let dbID: String?
    let sessionID: String
    let nickname: String?
    let project: SessionProject?
    let status: String?
    let terminalSessionID: String?

    enum CodingKeys: String, CodingKey {
        case dbID = "id"
        case sessionID = "session_id"
        case nickname
        case project
        case status
        case terminalSessionID = "terminal_session_id"
    }

    var id: String { sessionID }
    var displayName: String { nickname?.isEmpty == false ? nickname! : shortID }
    var shortID: String { String(sessionID.prefix(8)) }
    var projectName: String { project?.displayName ?? project?.name ?? "Unknown Project" }
    var isActive: Bool { status == "active" }
}

struct SessionProject: Decodable, Hashable {
    let id: String?
    let name: String?
    let handle: String?
    let displayName: String?
}

struct LiveMessageSendResponse: Decodable {
    let messages: [SentMessage]
}

struct SentMessage: Decodable, Hashable {
    let toSessionID: String

    enum CodingKeys: String, CodingKey {
        case toSessionID = "to_session_id"
    }
}

enum VoiceComposerState: String {
    case idle
    case recording
    case review
    case sent
}

struct SessionGroup: Identifiable {
    let name: String
    let sessions: [ActiveSession]

    var id: String { name }
}
