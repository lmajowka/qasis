# Read-only view of a Qasis install: the files and services that the Node
# installer (setup/) and runner (src/) leave behind. Nothing here writes to
# them, and the API key itself is never read.
module Qasis
  SEVERITIES = %w[critical high medium low].freeze

  PROVIDERS = {
    "anthropic" => { label: "Anthropic (Claude)", default_model: "claude-opus-5-5" },
    "openai" => { label: "OpenAI", default_model: "gpt-5" },
    "deepseek" => { label: "DeepSeek", default_model: "deepseek-v4-pro" }
  }.freeze

  DEFAULT_FLOW_INTERVAL_HOURS = 4

  module_function

  # The qasis checkout this app lives in, unless QASIS_ROOT says otherwise.
  def root
    Pathname.new(ENV.fetch("QASIS_ROOT") { Rails.root.parent.to_s }).expand_path
  end

  def reports_dir
    Pathname.new(ENV.fetch("QASIS_REPORTS") { root.join("reports").to_s }).expand_path
  end

  # Same rule as config.mjs / credentials.mjs: honours XDG_CONFIG_HOME.
  def config_dir
    base = ENV["XDG_CONFIG_HOME"].presence || File.join(Dir.home, ".config")
    Pathname.new(base).join("qasis")
  end

  # Same rule as siteSlug() in src/crawl.mjs.
  def site_slug(url)
    URI.parse(url).host.to_s.gsub(/[^a-z0-9.-]/i, "_")
  rescue URI::InvalidURIError
    url.to_s.gsub(/[^a-z0-9.-]/i, "_")
  end

  def read_json(path)
    JSON.parse(File.read(path))
  rescue Errno::ENOENT, Errno::EACCES, JSON::ParserError
    nil
  end

  def time(iso)
    Time.iso8601(iso) if iso.present?
  rescue ArgumentError
    nil
  end

  # Runs a helper without a shell; returns [stdout, success?].
  def run(*cmd)
    out, _err, status = Open3.capture3(*cmd)
    [ out, status.success? ]
  rescue SystemCallError
    [ "", false ]
  end

  def pid_alive?(pid)
    return false unless pid.to_i.positive?
    Process.kill(0, pid.to_i)
    true
  rescue Errno::EPERM
    true
  rescue Errno::ESRCH, RangeError
    false
  end
end
