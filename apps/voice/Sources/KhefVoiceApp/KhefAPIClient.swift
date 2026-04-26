import Foundation

struct KhefAPIClient {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func fetchActiveSessions() async throws -> [ActiveSession] {
        let url = baseURL.appending(path: "/api/active-sessions")
        var request = URLRequest(url: url)
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(ActiveSessionsResponse.self, from: data).sessions
    }

    @discardableResult
    func sendMessage(transcript: String, to target: String, from sender: String) async throws -> LiveMessageSendResponse {
        let url = baseURL.appending(path: "/api/live-messages/\(target.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? target)")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "from_session_id": sender,
            "content": transcript,
        ])

        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(LiveMessageSendResponse.self, from: data)
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "Unknown response body"
            throw NSError(
                domain: "KhefAPIClient",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: body]
            )
        }
    }
}
