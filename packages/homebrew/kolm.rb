# Homebrew formula for the kolm CLI.
#
# Tap:    kolm-ai/kolm
# Usage:  brew tap kolm-ai/kolm && brew install kolm
#
# This formula is intentionally minimal. The kolm CLI is a Node entry point
# (cli/kolm.js) shipped from the GitHub release tarball; the formula wraps it
# with a stub at bin/kolm and pins Node 20 LTS as the runtime dependency.
#
# We do not vendor binaries here. The verifier and runtime are JS + Python
# (Python deps are installed lazily on first compile/run via `kolm doctor`).

class Kolm < Formula
  desc "Compile, sign, and verify .kolm artifacts. Receipts for every inference."
  homepage "https://kolm.ai"
  url "https://github.com/kolm-ai/kolm/archive/refs/tags/v0.2.6.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"
  head "https://github.com/kolm-ai/kolm.git", branch: "main"

  depends_on "node@20"

  def install
    libexec.install Dir["*"]
    (bin/"kolm").write <<~SHIM
      #!/bin/bash
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/cli/kolm.js" "$@"
    SHIM
    (bin/"kolm").chmod 0755
  end

  test do
    assert_match "kolm v", shell_output("#{bin}/kolm --version")
    assert_match "Usage:", shell_output("#{bin}/kolm --help")
  end
end
