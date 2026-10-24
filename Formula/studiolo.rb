class Studiolo < Formula
  include Language::Python::Virtualenv

  desc "Self-hosted personal cloud desktop"
  homepage "https://github.com/rexding97/studiolo"
  url "https://github.com/rexding97/studiolo/archive/refs/tags/v0.1.1.tar.gz"
  sha256 "7e8eb942e20683cc4783a1878ff278af038e1a226e65da5a2882a95daef1780a"
  license "MIT"

  depends_on "python@3.12"

  resource "psutil" do
    url "https://files.pythonhosted.org/packages/26/10/2a30b13c61e7cf937f4adf90710776b7918ed0a9c434e2c38224732af310/psutil-6.1.0.tar.gz"
    sha256 "353815f59a7f64cdaca1c0307ee13558a0512f6db064e92fe833784f08539c7a"
  end

  def install
    venv = virtualenv_create(libexec, "python3.12")
    venv.pip_install resources

    libexec.install "server"
    libexec.install "web"

    (var/"studiolo").mkpath

    (bin/"studiolo").write <<~EOS
      #!/bin/bash
      set -e
      DATA_DIR="#{var}/studiolo"
      mkdir -p "$DATA_DIR"
      exec "#{libexec}/bin/python" "#{libexec}/server/rexhub.py" \
        --web "#{libexec}/web" \
        --data "$DATA_DIR/rexhub.db" \
        "$@"
    EOS
    chmod 0755, bin/"studiolo"
  end

  service do
    run [opt_bin/"studiolo", "--port", "3002"]
    keep_alive true
    working_dir var/"studiolo"
    log_path var/"log/studiolo.log"
    error_log_path var/"log/studiolo.log"
  end

  test do
    assert_match "usage", shell_output("#{bin}/studiolo --help 2>&1")
  end
end
