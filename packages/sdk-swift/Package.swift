// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Kolm",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .tvOS(.v17),
        .watchOS(.v10),
    ],
    products: [
        .library(name: "Kolm", targets: ["Kolm"]),
    ],
    targets: [
        .target(name: "Kolm", path: "Sources/Kolm"),
        .testTarget(name: "KolmTests", dependencies: ["Kolm"], path: "Tests/KolmTests"),
    ]
)
