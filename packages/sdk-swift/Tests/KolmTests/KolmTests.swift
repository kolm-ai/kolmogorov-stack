import XCTest
@testable import Kolm

final class KolmTests: XCTestCase {
    func testMissingArtifactErrorIsDescriptive() {
        XCTAssertThrowsError(try Kolm.load(named: "missing-artifact-for-test", bundle: Bundle.main)) { error in
            XCTAssertTrue(String(describing: error).contains("missing artifact"))
        }
    }
}
