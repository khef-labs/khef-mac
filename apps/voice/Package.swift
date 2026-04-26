// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "KhefVoiceApp",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "KhefVoiceApp", targets: ["KhefVoiceApp"]),
    ],
    targets: [
        .executableTarget(
            name: "KhefVoiceApp",
            path: "Sources/KhefVoiceApp"
        ),
    ]
)
