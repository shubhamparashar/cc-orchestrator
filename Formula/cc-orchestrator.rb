class CcOrchestrator < Formula
  desc "Local-first, read-only dashboard over all your Claude Code sessions"
  homepage "https://github.com/shubhamparashar/cc-orchestrator"
  url "https://github.com/shubhamparashar/cc-orchestrator.git",
      using: :git, tag: "v1.8.0"
  version "1.8.0"
  license "MIT"

  depends_on "node"

  def install
    libexec.install "server.mjs", "lib", "public", "bin", "hooks", "jobs",
                    "README.md", "REPORT.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"
    node_bin = formula_opt_bin("node")
    # The entry points carry `#!/usr/bin/env node`; the wrappers put the brewed
    # node on PATH so they resolve it without depending on a system install.
    (bin/"cc-orchestrator").write_env_script libexec/"server.mjs", PATH: "#{node_bin}:$PATH"
    %w[cc-doctor cc-install-hooks cc-logs].each do |cmd|
      (bin/cmd).write_env_script libexec/"bin"/cmd, PATH: "#{node_bin}:$PATH"
    end
  end

  service do
    run [opt_bin/"cc-orchestrator"]
    keep_alive true
    log_path var/"log/cc-orchestrator.log"
    error_log_path var/"log/cc-orchestrator.log"
  end

  def caveats
    <<~EOS
      cc-orchestrator serves http://127.0.0.1:7433 and reads (never writes) ~/.claude.

      Run it always-on:
        brew services start cc-orchestrator

      For the rolling per-session context.md, related-sessions, and the 70%-context
      warning, wire the Claude Code hooks once:
        cc-install-hooks
    EOS
  end

  test do
    assert_path_exists libexec/"server.mjs"
    system formula_opt_bin("node")/"node", "--check", libexec/"server.mjs"
  end
end
